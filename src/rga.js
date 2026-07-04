'use strict';

// Replicated Growable Array (RGA) - a CRDT for real time collaborative
// plain text editing. Zero dependencies: this file runs unmodified under
// Node.js (via module.exports) and in a plain <script> tag (via window.RGA).
//
// Core idea: every character ever inserted becomes a Node with a globally
// unique id (siteId + a per-site monotonically increasing counter), plus a
// pointer to the id of the character it was inserted immediately after (its
// "origin"). Nodes are never physically removed on delete, they are
// tombstoned, because a concurrent operation from another site might still
// reference a deleted node as its insertion anchor.
//
// Convergence relies on two things:
//   1. Every operation is applied only after its causal dependency (the
//      origin node it was inserted after, or the target node for a delete)
//      is already present. Operations that arrive early are buffered and
//      replayed once the dependency shows up - this is what makes the
//      algorithm correct under arbitrary out-of-order network delivery.
//   2. When two sites concurrently insert characters anchored at the same
//      origin, every replica must place them in the same relative order.
//      This implementation resolves that by walking the origin chain: a
//      new node is inserted after every existing node that (a) descends
//      from the same origin (directly or transitively, through a chain of
//      concurrent insertions) and (b) sorts higher under a fixed, arbitrary
//      total order over ids. Because that rule is identical on every
//      replica, the final order never depends on delivery order.

function makeId(siteId, counter) {
  return siteId + ':' + counter;
}

function parseId(id) {
  const idx = id.lastIndexOf(':');
  return { siteId: id.slice(0, idx), counter: Number(id.slice(idx + 1)) };
}

// Deterministic total order over ids, used only to break ties between
// concurrent insertions at the same anchor point. The specific rule (higher
// counter wins, site id as tiebreak) doesn't matter for correctness, only
// that every replica applies the identical rule.
function idGreater(aId, bId) {
  const a = parseId(aId);
  const b = parseId(bId);
  if (a.counter !== b.counter) return a.counter > b.counter;
  return a.siteId > b.siteId;
}

class RGA {
  constructor(siteId) {
    if (!siteId) throw new Error('RGA requires a unique siteId');
    this.siteId = siteId;
    this.counter = 0;
    this.sequence = []; // ordered list of {id, originId, char, deleted}
    this.index = new Map(); // id -> node, O(1) lookup
    this.pendingByOrigin = new Map(); // originId -> insert ops waiting on it
    this.pendingByTarget = new Map(); // targetId -> delete ops waiting on it
  }

  // ---- local edits: call these on your own replica, then broadcast the
  // returned op to every other replica via applyRemote ----

  insertAt(pos, char) {
    if (typeof char !== 'string' || char.length !== 1) {
      throw new Error('insertAt expects a single character');
    }
    const originId = this._visibleIdBefore(pos);
    if (originId === undefined) throw new Error('insertAt: position out of range');
    const id = makeId(this.siteId, this.counter++);
    const op = { type: 'insert', id: id, originId: originId, char: char };
    this._applyInsert(op);
    return op;
  }

  insertText(pos, text) {
    const ops = [];
    for (let i = 0; i < text.length; i++) ops.push(this.insertAt(pos + i, text[i]));
    return ops;
  }

  deleteAt(pos) {
    const id = this._visibleIdAt(pos);
    if (id === undefined) return null;
    const op = { type: 'delete', id: id };
    this._applyDelete(op);
    return op;
  }

  // ---- remote operations produced by insertAt/deleteAt on any replica ----

  applyRemote(op) {
    if (op.type === 'insert') this._applyInsert(op);
    else if (op.type === 'delete') this._applyDelete(op);
    else throw new Error('unknown op type: ' + op.type);
  }

  // ---- read-only helpers ----

  toString() {
    let out = '';
    for (let i = 0; i < this.sequence.length; i++) {
      if (!this.sequence[i].deleted) out += this.sequence[i].char;
    }
    return out;
  }

  get length() {
    let n = 0;
    for (let i = 0; i < this.sequence.length; i++) if (!this.sequence[i].deleted) n++;
    return n;
  }

  // number of ops still waiting on a causal dependency - exposed mainly so
  // tests and the demo UI can confirm every buffered op eventually flushes.
  get pendingCount() {
    let n = 0;
    for (const list of this.pendingByOrigin.values()) n += list.length;
    for (const list of this.pendingByTarget.values()) n += list.length;
    return n;
  }

  // ---- internals ----

  _visibleIdBefore(pos) {
    if (pos === 0) return null; // null origin = insert at the very start
    return this._visibleIdAt(pos - 1);
  }

  _visibleIdAt(pos) {
    if (pos < 0) return undefined;
    let seen = -1;
    for (let i = 0; i < this.sequence.length; i++) {
      const node = this.sequence[i];
      if (!node.deleted) {
        seen++;
        if (seen === pos) return node.id;
      }
    }
    return undefined;
  }

  // Is `node` reachable from ancestor id `ancId` by following .originId
  // pointers? Used to tell whether an existing node sitting after our
  // insertion anchor belongs to the same "concurrent insertion group" as
  // the node we're about to insert, as opposed to being unrelated content
  // that merely happens to sit further down the sequence.
  _descendsFrom(node, ancId) {
    let cur = node;
    while (cur.originId !== null) {
      if (cur.originId === ancId) return true;
      cur = this.index.get(cur.originId);
      if (!cur) return false;
    }
    return false;
  }

  _applyInsert(op) {
    if (this.index.has(op.id)) return; // already applied - ops are idempotent

    if (op.originId !== null && !this.index.has(op.originId)) {
      // Causal dependency (the left neighbor) hasn't arrived yet - buffer
      // this op and replay it once that neighbor is inserted.
      const list = this.pendingByOrigin.get(op.originId) || [];
      list.push(op);
      this.pendingByOrigin.set(op.originId, list);
      return;
    }

    const node = { id: op.id, originId: op.originId, char: op.char, deleted: false };
    let i = op.originId === null ? 0 : this._nodeIndex(op.originId) + 1;

    // Walk forward past every node that (a) is a descendant of our origin,
    // reached through a chain of concurrent insertions, and (b) sorts
    // higher than the new node under the fixed tiebreak order. This keeps
    // concurrent siblings in the same relative order on every replica,
    // regardless of the order operations were delivered in.
    while (i < this.sequence.length) {
      const o = this.sequence[i];
      const related = op.originId === null ? true : this._descendsFrom(o, op.originId);
      if (!related) break;
      if (idGreater(o.id, op.id)) {
        i++;
        continue;
      }
      break;
    }

    this.sequence.splice(i, 0, node);
    this.index.set(node.id, node);

    const waitingInserts = this.pendingByOrigin.get(op.id);
    if (waitingInserts) {
      this.pendingByOrigin.delete(op.id);
      for (const waiting of waitingInserts) this._applyInsert(waiting);
    }
    const waitingDeletes = this.pendingByTarget.get(op.id);
    if (waitingDeletes) {
      this.pendingByTarget.delete(op.id);
      for (const waiting of waitingDeletes) this._applyDelete(waiting);
    }
  }

  _applyDelete(op) {
    const node = this.index.get(op.id);
    if (!node) {
      // Delete arrived before its target insert - buffer it too.
      const list = this.pendingByTarget.get(op.id) || [];
      list.push(op);
      this.pendingByTarget.set(op.id, list);
      return;
    }
    node.deleted = true;
  }

  _nodeIndex(id) {
    for (let i = 0; i < this.sequence.length; i++) if (this.sequence[i].id === id) return i;
    throw new Error('node not found: ' + id);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RGA: RGA };
}
if (typeof window !== 'undefined') {
  window.RGA = RGA;
}
