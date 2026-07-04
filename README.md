# RGA CRDT Editor

A dependency-free implementation of the **Replicated Growable Array (RGA)**,
a Conflict-free Replicated Data Type (CRDT) for real-time collaborative
plain-text editing. Includes a from-scratch causal-delivery layer, a Node
test suite (unit tests plus a randomized convergence fuzz test), and a
3-client browser demo that simulates an unreliable, out-of-order network.

## What it does, and why it's useful

Google Docs-style collaborative editors need every participant's copy of a
document to end up identical, even though edits arrive over the network in
different orders on different machines, sometimes delayed, sometimes out of
order relative to each other. Two classic approaches solve this:
Operational Transformation (what early Google Docs used) and CRDTs, which
sidestep the transform step entirely by designing the data structure so
that merging is automatically commutative and idempotent.

This project implements the RGA algorithm from ["Replicated abstract data
types: Building blocks for collaborative applications"](https://www.sciencedirect.com/science/article/pii/S0743731510002716)
(Roh et al., 2011), one of the foundational sequence CRDTs and a direct
ancestor of the algorithms used in real systems like Apache Wave and early
versions of collaborative editors built on Yjs-style architectures.

Each character typed into the document becomes a node carrying:

- a globally unique id (`siteId:counter`)
- a pointer to the id of the character it was inserted immediately after
  (its "origin")
- a tombstone flag instead of physical deletion, so concurrent operations
  that still reference a deleted character as their anchor keep working

Two replicas that have seen the same set of insert/delete operations always
converge to the same visible string, regardless of the order those
operations were delivered or applied in. No central server, no locking, no
transform function required.

## How to run it

Requires Node.js 18+ (for the built-in `node:test` runner) and no other
dependencies.

```bash
git clone https://github.com/MohammadHossinzehi/2026-07-03-am-rga-crdt-editor.git
cd 2026-07-03-am-rga-crdt-editor
npm test
```

`npm test` runs `node --test test/`, which executes:

- sequential single-replica edit tests
- convergence tests for two replicas receiving the same ops in different
  orders
- an idempotency test (applying the same op twice is a no-op)
- an out-of-order delivery test (a child op arrives before the parent it
  depends on, gets buffered, then flushes once the parent shows up)
- a concurrent-insert-at-the-same-position test
- a concurrent insert-next-to-a-concurrent-delete test
- a 20-trial randomized fuzz test that generates random concurrent
  insert/delete sequences across three sites, delivers them to two
  observers in two different random orders, and asserts both observers end
  up byte-for-byte identical with zero operations left stuck in the
  buffering layer

To try the interactive demo, just open `demo/index.html` in a browser
(or serve the repo root with any static file server, e.g.
`python3 -m http.server`, then visit `/demo/index.html`). It shows three
independent replicas (Alice, Bob, Carol) wired together by a simulated
network with adjustable random delay. Click "Run chaos burst" to have all
three type concurrently, and watch the "converged?" badge settle to green
once every op has propagated, no matter how badly the simulated network
reordered things along the way.

## Design decisions and testing notes

**Why RGA instead of Operational Transformation.** OT requires a central
server (or a more complex peer-to-peer transform protocol) to serialize
concurrent operations correctly. RGA is fully decentralized: any two
replicas that have received the same operations converge, in any delivery
order, with no coordination.

**Tombstones instead of physical deletes.** If a deleted character were
removed from the structure entirely, a concurrent insert that used it as an
anchor point would have nothing to attach to. Keeping a tombstone (a
`deleted: true` flag) means the anchor is always resolvable; the tombstone
only disappears from `toString()` output, never from the underlying
sequence.

**Causal buffering.** An insert operation's origin, or a delete operation's
target, might not have arrived yet when the operation itself does (the
network reordered them). Rather than requiring a delivery-order guarantee
from the transport layer, this implementation buffers any operation whose
dependency is missing and replays it (recursively, since a whole chain of
buffered ops can cascade) the moment that dependency is satisfied. This is
what lets the demo get away with a network that delivers messages in
literally any order.

**Resolving concurrent inserts at the same anchor.** When two sites
concurrently insert a character right after the same existing character,
every replica needs to agree on which one ends up first. This
implementation walks the origin chain of each candidate neighbor to check
whether it descends from the same anchor (directly or through a chain of
other concurrent insertions), and if so places new nodes after any such
descendant that sorts higher under a fixed, arbitrary tiebreak order
(insertion counter, then site id). Because every replica applies the exact
same rule, the outcome never depends on arrival order. This was the one
part of the implementation that actually needed the randomized fuzz test to
get right - an earlier, simpler version that only checked for *direct*
same-origin siblings passed the small hand-written test cases but diverged
under the fuzz test once insertions chained three or more levels deep. The
fix (checking full descendance via the origin chain, not just direct
equality) is what's now in `src/rga.js`.

**Known limitations.** This implementation optimizes for clarity over
performance: lookups and origin-chain walks are O(n) in the number of
characters ever inserted (including tombstones), so it's well suited for
demos, tests, and documents up to a few tens of thousands of characters,
but a production system would want a balanced tree or skip-list index
instead of a flat array. There's also no undo/redo, no rich text, and no
actual network transport - `applyRemote` is meant to be called by whatever
transport layer (WebSocket, WebRTC data channel, etc.) you plug in.

## Project structure

```
src/rga.js        core RGA CRDT implementation (no dependencies)
test/rga.test.js  unit tests + randomized convergence fuzz test (node:test)
demo/index.html   3-client browser demo UI
demo/demo.js      demo wiring: simulated network, buttons, convergence badge
package.json      npm metadata + `npm test` script
```
