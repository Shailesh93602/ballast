/**
 * Virtual time and the event queue.
 *
 * Every event carries `(vtime, seq)`. `vtime` is when it happens in simulated
 * ticks; `seq` is a monotonically increasing insertion counter.
 *
 * THE SEQ TIEBREAK IS THE LOAD-BEARING PART. Two events scheduled for the same
 * tick have to be totally ordered somehow, and if the comparator returns 0 the
 * order falls to heap-internal sift behaviour — stable in practice, but stable
 * for reasons nobody wrote down and nobody tests. Since scheduling one extra
 * event anywhere upstream can change sift paths, that ambiguity shows up as a
 * one-in-a-thousand hash mismatch that looks like a real bug. Making `seq` part
 * of the key removes the ambiguity by construction: no two events ever compare
 * equal.
 */

export type Ticks = number;

export interface ScheduledEvent<E> {
  readonly vtime: Ticks;
  readonly seq: number;
  readonly payload: E;
}

/**
 * Min-heap over (vtime, seq). Hand-rolled because the project takes zero runtime
 * dependencies, and because the comparator is the thing under scrutiny — it
 * should be readable in the same file as the argument for why it is correct.
 */
export class EventQueue<E> {
  private heap: Array<ScheduledEvent<E>> = [];
  private nextSeq = 0;

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** Peek at the next event's time without removing it. */
  peekTime(): Ticks | undefined {
    return this.heap[0]?.vtime;
  }

  schedule(vtime: Ticks, payload: E): ScheduledEvent<E> {
    if (!Number.isFinite(vtime)) {
      throw new Error(`schedule: non-finite vtime ${vtime}`);
    }
    if (!Number.isInteger(vtime)) {
      throw new Error(
        `schedule: vtime must be an integer tick, got ${vtime}. ` +
          "Fractional ticks reintroduce float-comparison ambiguity into the ordering.",
      );
    }
    const ev: ScheduledEvent<E> = { vtime, seq: this.nextSeq++, payload };
    this.heap.push(ev);
    this.siftUp(this.heap.length - 1);
    return ev;
  }

  pop(): ScheduledEvent<E> | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0] as ScheduledEvent<E>;
    const last = this.heap.pop() as ScheduledEvent<E>;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Total order: earlier tick first, then earlier insertion. Never returns 0. */
  private before(a: ScheduledEvent<E>, b: ScheduledEvent<E>): boolean {
    if (a.vtime !== b.vtime) return a.vtime < b.vtime;
    return a.seq < b.seq;
  }

  private siftUp(i: number): void {
    let idx = i;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      const a = this.heap[idx] as ScheduledEvent<E>;
      const b = this.heap[parent] as ScheduledEvent<E>;
      if (!this.before(a, b)) break;
      this.heap[idx] = b;
      this.heap[parent] = a;
      idx = parent;
    }
  }

  private siftDown(i: number): void {
    let idx = i;
    const n = this.heap.length;
    for (;;) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (
        left < n &&
        this.before(
          this.heap[left] as ScheduledEvent<E>,
          this.heap[smallest] as ScheduledEvent<E>,
        )
      ) {
        smallest = left;
      }
      if (
        right < n &&
        this.before(
          this.heap[right] as ScheduledEvent<E>,
          this.heap[smallest] as ScheduledEvent<E>,
        )
      ) {
        smallest = right;
      }
      if (smallest === idx) break;
      const tmp = this.heap[idx] as ScheduledEvent<E>;
      this.heap[idx] = this.heap[smallest] as ScheduledEvent<E>;
      this.heap[smallest] = tmp;
      idx = smallest;
    }
  }
}

/**
 * The simulation clock. Time only moves when an event is dequeued, and it never
 * moves backwards — an event scheduled in the past is a programming error, not
 * something to tolerate quietly, because it would let a policy observe an
 * ordering the reference oracle cannot reproduce.
 */
export class Clock<E> {
  private currentTime: Ticks = 0;
  private readonly queue = new EventQueue<E>();

  now(): Ticks {
    return this.currentTime;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Schedule `delay` ticks from now. `delay` of 0 means "later this same tick". */
  scheduleIn(delay: Ticks, payload: E): void {
    if (delay < 0) throw new Error(`scheduleIn: negative delay ${delay}`);
    this.queue.schedule(this.currentTime + delay, payload);
  }

  scheduleAt(vtime: Ticks, payload: E): void {
    if (vtime < this.currentTime) {
      throw new Error(
        `scheduleAt: ${vtime} is before now (${this.currentTime}). ` +
          "Time must not move backwards; this is a bug in the caller.",
      );
    }
    this.queue.schedule(vtime, payload);
  }

  /** Advance to the next event and return it. Undefined when the queue drains. */
  advance(): ScheduledEvent<E> | undefined {
    const ev = this.queue.pop();
    if (ev === undefined) return undefined;
    this.currentTime = ev.vtime;
    return ev;
  }
}
