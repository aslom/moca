import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { adoptTurnSlot, attachTurnSlot } from '../src/turn-slot.js';

/** A ServerResponse stand-in: the slot contract only needs 'close' emission. */
const fakeRes = (): ServerResponse => new EventEmitter() as unknown as ServerResponse;

describe('turn slot with multiple ends', () => {
  it('fires every attached end, once, when the response closes', () => {
    const res = fakeRes();
    const turnEnd = vi.fn();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, turnEnd); // the worker's count, before the route runs
    attachTurnSlot(res, subjectEnd); // the route's own count, once it knows the subject (#360)
    res.emit('close');
    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(subjectEnd).toHaveBeenCalledTimes(1);
    res.emit('close'); // ends are idempotent by construction; a second close must not re-run them
    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('adoption defers every end to the adopted release, past the close', () => {
    const res = fakeRes();
    const turnEnd = vi.fn();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, turnEnd);
    attachTurnSlot(res, subjectEnd);
    const release = adoptTurnSlot(res);
    res.emit('close');
    expect(turnEnd).not.toHaveBeenCalled();
    expect(subjectEnd).not.toHaveBeenCalled();
    release();
    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('a slot attached outside a worker still rides close (the standalone tier)', () => {
    const res = fakeRes();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, subjectEnd);
    res.emit('close');
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('a slot attached outside a worker is still adopted by a detachable turn', () => {
    // Without this, a detachable turn on the standalone tier would release the subject's slot at
    // response close while the turn itself runs on — the very leak the adoption mechanism exists
    // to prevent, reached by the second end.
    const res = fakeRes();
    const subjectEnd = vi.fn();
    attachTurnSlot(res, subjectEnd);
    const release = adoptTurnSlot(res);
    res.emit('close');
    expect(subjectEnd).not.toHaveBeenCalled();
    release();
    expect(subjectEnd).toHaveBeenCalledTimes(1);
  });

  it('adoptTurnSlot on a response that never had a slot is a no-op', () => {
    const res = fakeRes();
    const release = adoptTurnSlot(res);
    expect(() => release()).not.toThrow();
  });
});
