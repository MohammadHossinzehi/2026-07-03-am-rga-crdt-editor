'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RGA } = require('../src/rga.js');

test('sequential local edits on a single replica', () => {
  const doc = new RGA('a');
  doc.insertText(0, 'hello');
  assert.equal(doc.toString(), 'hello');
  doc.deleteAt(0); // remove 'h'
  assert.equal(doc.toString(), 'ello');
  doc.insertAt(0, 'j');
  assert.equal(doc.toString(), 'jello');
});

test('two replicas converge for non concurrent edits applied in order', () => {
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  const ops = alice.insertText(0, 'hi');
  for (const op of ops) bob.applyRemote(op);
  assert.equal(alice.toString(), 'hi');
  assert.equal(bob.toString(), 'hi');
});

test('operations are idempotent - applying the same op twice is a no-op', () => {
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  const op = alice.insertAt(0, 'x');
  bob.applyRemote(op);
  bob.applyRemote(op);
  assert.equal(bob.toString(), 'x');
});

test('out of order delivery: a dependent insert arriving before its origin is buffered then applied', () => {
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  const op1 = alice.insertAt(0, 'a'); // origin: null
  const op2 = alice.insertAt(1, 'b'); // origin: op1.id
  const op3 = alice.insertAt(2, 'c'); // origin: op2.id
  assert.equal(alice.toString(), 'abc');

  // Deliver to bob in reverse order.
  bob.applyRemote(op3);
  bob.applyRemote(op2);
  assert.equal(bob.toString(), '', 'nothing should be visible yet, all buffered');
  bob.applyRemote(op1);
  assert.equal(bob.toString(), 'abc', 'buffered ops should flush once their dependency arrives');
});

test('concurrent inserts at the same position converge to the same order on every replica', () => {
  // Both alice and bob start from the same empty state and, without seeing
  // each other's op yet, each insert one character at position 0.
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  const opAlice = alice.insertAt(0, 'A');
  const opBob = bob.insertAt(0, 'B');

  // Replica 1 sees alice's op first, then bob's.
  const replica1 = new RGA('r1');
  replica1.applyRemote(opAlice);
  replica1.applyRemote(opBob);

  // Replica 2 sees bob's op first, then alice's.
  const replica2 = new RGA('r2');
  replica2.applyRemote(opBob);
  replica2.applyRemote(opAlice);

  assert.equal(replica1.toString(), replica2.toString());
  assert.equal(replica1.toString().length, 2);
});

test('concurrent insert next to a concurrently deleted character converges', () => {
  const base = new RGA('base');
  const setup = base.insertText(0, 'ac');

  const alice = new RGA('alice');
  const bob = new RGA('bob');
  for (const op of setup) {
    alice.applyRemote(op);
    bob.applyRemote(op);
  }
  assert.equal(alice.toString(), 'ac');

  // Alice inserts 'b' between 'a' and 'c'. Bob concurrently deletes 'c'.
  const insertOp = alice.insertAt(1, 'b');
  const deleteOp = bob.deleteAt(1); // deletes 'c' on bob's replica

  alice.applyRemote(deleteOp);
  bob.applyRemote(insertOp);

  assert.equal(alice.toString(), bob.toString());
  assert.equal(alice.toString(), 'ab');
});

test('fuzz: random concurrent edits across three replicas always converge', () => {
  for (let trial = 0; trial < 20; trial++) {
    const sites = ['s1', 's2', 's3'].map((id) => new RGA(id));
    const allOps = [];

    for (const site of sites) {
      const n = 1 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) {
        if (site.length === 0 || Math.random() < 0.7) {
          const pos = Math.floor(Math.random() * (site.length + 1));
          const ch = String.fromCharCode(97 + Math.floor(Math.random() * 26));
          allOps.push(site.insertAt(pos, ch));
        } else {
          const pos = Math.floor(Math.random() * site.length);
          allOps.push(site.deleteAt(pos));
        }
      }
    }

    // Shuffle all ops and deliver the full history to a fresh replica per
    // site, simulating an arbitrary, out of order network.
    const shuffled = allOps.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const observer1 = new RGA('o1');
    const observer2 = new RGA('o2');
    for (const op of shuffled) observer1.applyRemote(op);
    const reshuffled = shuffled.slice().reverse();
    for (const op of reshuffled) observer2.applyRemote(op);

    assert.equal(observer1.pendingCount, 0, 'all ops should have flushed, none left buffered');
    assert.equal(observer2.pendingCount, 0, 'all ops should have flushed, none left buffered');
    assert.equal(observer1.toString(), observer2.toString(), 'trial ' + trial + ' diverged');
  }
});
