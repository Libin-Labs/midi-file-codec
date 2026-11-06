export type MidiDivision =
  | { readonly type: 'ppq'; readonly ticksPerQuarter: number }
  | {
      readonly type: 'smpte';
      readonly framesPerSecond: 24 | 25 | 29 | 30;
      readonly ticksPerFrame: number;
    };

export type MidiChannelKind =
  | 'noteOff'
  | 'noteOn'
  | 'polyPressure'
  | 'controller'
  | 'program'
  | 'channelPressure'
  | 'pitchBend';

export interface MidiChannelEvent {
  readonly type: 'channel';
  /** Ticks since the previous event in the track. */
  readonly delta: number;
  readonly kind: MidiChannelKind;
  /** 0..15 */
  readonly channel: number;
  /** First 7-bit data byte (note, controller, program, pressure, or pitch-bend LSB). */
  readonly data1: number;
  /** Second 7-bit data byte; absent for program and channelPressure. */
  readonly data2?: number;
}

export interface MidiMetaEvent {
  readonly type: 'meta';
  readonly delta: number;
  /** 0..127 (0x2F end-of-track is handled by the codec). */
  readonly metaType: number;
  readonly data: Uint8Array;
}

export interface MidiSysexEvent {
  readonly type: 'sysex';
  readonly delta: number;
  /** false for an F0 sysex, true for an F7 escape. */
  readonly escape: boolean;
  /** Payload bytes after the length field (an F0 payload normally ends with 0xF7). */
  readonly data: Uint8Array;
}

export type MidiEvent = MidiChannelEvent | MidiMetaEvent | MidiSysexEvent;

export interface MidiFile {
  readonly format: 0 | 1;
  readonly division: MidiDivision;
  /** Each track's events including its final end-of-track meta event when decoded. */
  readonly tracks: readonly (readonly MidiEvent[])[];
}

export interface MidiDecodeOptions {
  /** Maximum input byte length. Default 67,108,864. */
  maxBytes?: number;
  /** Maximum total events across tracks. Default 1,000,000. */
  maxEvents?: number;
}

export interface MidiEncodeOptions {
  /** Omit repeated channel status bytes. Default false. */
  runningStatus?: boolean;
  /** Maximum total events. Default 1,000,000. */
  maxEvents?: number;
}

export type MidiErrorCode =
  'truncated' | 'bad-header' | 'bad-track' | 'bad-event' | 'unsupported' | 'limit';

export class MidiError extends Error {
  readonly code: MidiErrorCode;
  readonly offset: number | undefined;
  constructor(code: MidiErrorCode, message: string, offset?: number) {
    super(message);
    this.name = 'MidiError';
    this.code = code;
    this.offset = offset;
  }
}

const KINDS: readonly MidiChannelKind[] = [
  'noteOff',
  'noteOn',
  'polyPressure',
  'controller',
  'program',
  'channelPressure',
  'pitchBend',
];
const MAX_VLQ = 0x0fffffff;

function posInt(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer`);
  return v;
}

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

function decodeTrack(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: { left: number },
): MidiEvent[] {
  const events: MidiEvent[] = [];
  let at = start;
  let running = -1;
  const vlq = (): number => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      if (at >= end)
        throw new MidiError('bad-event', 'variable-length quantity runs past the track', at);
      const b = bytes[at++]!;
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new MidiError('bad-event', 'variable-length quantity longer than 4 bytes', at);
  };
  while (at < end) {
    if (--budget.left < 0) throw new MidiError('limit', 'too many events', at);
    const delta = vlq();
    if (at >= end) throw new MidiError('bad-event', 'event has no status byte', at);
    let status = bytes[at]!;
    if (status < 0x80) {
      if (running < 0) throw new MidiError('bad-event', 'data byte without running status', at);
      status = running;
    } else {
      at++;
    }
    if (status === 0xff) {
      running = -1;
      if (at >= end) throw new MidiError('bad-event', 'meta event truncated', at);
      const metaType = bytes[at++]!;
      if (metaType > 0x7f) throw new MidiError('bad-event', 'meta type must be 0..127', at - 1);
      const length = vlq();
      if (at + length > end) throw new MidiError('bad-event', 'meta event exceeds track', at);
      if (metaType === 0x2f && (length !== 0 || at !== end)) {
        throw new MidiError('bad-event', 'end-of-track must be empty and last', at);
      }
      events.push({ type: 'meta', delta, metaType, data: bytes.slice(at, at + length) });
      at += length;
    } else if (status === 0xf0 || status === 0xf7) {
      running = -1;
      const length = vlq();
      if (at + length > end) throw new MidiError('bad-event', 'sysex event exceeds track', at);
      events.push({
        type: 'sysex',
        delta,
        escape: status === 0xf7,
        data: bytes.slice(at, at + length),
      });
      at += length;
    } else if (status >= 0xf1) {
      throw new MidiError(
        'unsupported',
        `status 0x${status.toString(16)} is not valid in a MIDI file`,
        at - 1,
      );
    } else {
      running = status;
      const count = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
      if (at + count > end) throw new MidiError('bad-event', 'channel event truncated', at);
      const data1 = bytes[at]!;
      const data2 = count === 2 ? bytes[at + 1]! : 0;
      if (data1 > 0x7f || data2 > 0x7f)
        throw new MidiError('bad-event', 'data byte has the high bit set', at);
      const kind = KINDS[(status >> 4) & 7]!;
      const base = { type: 'channel' as const, delta, kind, channel: status & 15, data1 };
      events.push(count === 2 ? { ...base, data2 } : base);
      at += count;
    }
  }
  const last = events[events.length - 1];
  if (last === undefined || last.type !== 'meta' || last.metaType !== 0x2f) {
    throw new MidiError('bad-track', 'track does not end with an end-of-track event', end);
  }
  return events;
}

/** Decodes a Standard MIDI File of format 0 or 1. */
export function decodeMidi(input: Uint8Array, options: MidiDecodeOptions = {}): MidiFile {
  if (!(input instanceof Uint8Array)) throw new TypeError('input must be a Uint8Array');
  const maxBytes = posInt(options.maxBytes, 67_108_864, 'maxBytes');
  const budget = { left: posInt(options.maxEvents, 1_000_000, 'maxEvents') };
  if (input.length > maxBytes) throw new MidiError('limit', 'input exceeds maxBytes');
  if (input.length < 14) throw new MidiError('truncated', 'header chunk truncated', 0);
  if (tag(input, 0) !== 'MThd') throw new MidiError('bad-header', 'missing MThd', 0);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const headerLength = view.getUint32(4, false);
  if (headerLength < 6) throw new MidiError('bad-header', 'header length must be at least 6', 4);
  if (8 + headerLength > input.length)
    throw new MidiError('truncated', 'header chunk truncated', 4);
  const format = view.getUint16(8, false);
  const trackCount = view.getUint16(10, false);
  const rawDivision = view.getUint16(12, false);
  if (format === 2)
    throw new MidiError('unsupported', 'format 2 (independent sequences) is not supported', 8);
  if (format !== 0 && format !== 1)
    throw new MidiError('bad-header', `unknown format ${format}`, 8);
  if (trackCount < 1 || (format === 0 && trackCount !== 1)) {
    throw new MidiError('bad-header', 'invalid track count for format', 10);
  }
  let division: MidiDivision;
  if (rawDivision & 0x8000) {
    const fps = 256 - (rawDivision >> 8);
    const ticksPerFrame = rawDivision & 0xff;
    if ((fps !== 24 && fps !== 25 && fps !== 29 && fps !== 30) || ticksPerFrame < 1) {
      throw new MidiError('bad-header', 'invalid SMPTE division', 12);
    }
    division = { type: 'smpte', framesPerSecond: fps, ticksPerFrame };
  } else {
    if (rawDivision < 1)
      throw new MidiError('bad-header', 'ticks per quarter note must be positive', 12);
    division = { type: 'ppq', ticksPerQuarter: rawDivision };
  }
  const tracks: MidiEvent[][] = [];
  let at = 8 + headerLength;
  while (at < input.length) {
    if (at + 8 > input.length) throw new MidiError('truncated', 'chunk header truncated', at);
    const id = tag(input, at);
    const length = view.getUint32(at + 4, false);
    const body = at + 8;
    if (body + length > input.length)
      throw new MidiError('truncated', `chunk ${JSON.stringify(id)} exceeds input`, at);
    if (id === 'MTrk') {
      if (tracks.length >= trackCount)
        throw new MidiError('bad-track', 'more MTrk chunks than the header declares', at);
      tracks.push(decodeTrack(input, body, body + length, budget));
    }
    at = body + length;
  }
  if (tracks.length !== trackCount)
    throw new MidiError('bad-track', 'fewer MTrk chunks than the header declares');
  return { format, division, tracks };
}

function pushVlq(out: number[], value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_VLQ)
    throw new RangeError(`${what} must be an integer 0..${MAX_VLQ}`);
  const parts = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128))
    parts.push((rest & 0x7f) | 0x80);
  for (let i = parts.length - 1; i >= 0; i--) out.push(parts[i]!);
}

function byte7(value: number | undefined, what: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > 0x7f)
    throw new RangeError(`${what} must be an integer 0..127`);
  return value;
}

function encodeTrack(events: readonly MidiEvent[], running: boolean): number[] {
  const out: number[] = [];
  let lastStatus = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    pushVlq(out, event.delta, 'delta');
    if (event.type === 'channel') {
      const kindIndex = KINDS.indexOf(event.kind);
      if (kindIndex < 0) throw new RangeError(`unknown channel event kind ${String(event.kind)}`);
      if (!Number.isInteger(event.channel) || event.channel < 0 || event.channel > 15)
        throw new RangeError('channel must be 0..15');
      const status = 0x80 | (kindIndex << 4) | event.channel;
      const twoBytes = event.kind !== 'program' && event.kind !== 'channelPressure';
      if (!running || status !== lastStatus) out.push(status);
      out.push(byte7(event.data1, 'data1'));
      if (twoBytes) out.push(byte7(event.data2, 'data2'));
      else if (event.data2 !== undefined)
        throw new RangeError(`${event.kind} takes a single data byte`);
      lastStatus = status;
    } else if (event.type === 'meta') {
      if (!Number.isInteger(event.metaType) || event.metaType < 0 || event.metaType > 0x7f)
        throw new RangeError('metaType must be 0..127');
      if (event.metaType === 0x2f) {
        if (i !== events.length - 1 || event.data.length !== 0)
          throw new RangeError('end-of-track must be empty and last');
      }
      out.push(0xff, event.metaType);
      pushVlq(out, event.data.length, 'meta length');
      for (const b of event.data) out.push(b);
      lastStatus = -1;
    } else if (event.type === 'sysex') {
      out.push(event.escape ? 0xf7 : 0xf0);
      pushVlq(out, event.data.length, 'sysex length');
      for (const b of event.data) out.push(b);
      lastStatus = -1;
    } else {
      throw new TypeError('unknown event type');
    }
  }
  const last = events[events.length - 1];
  if (last === undefined || last.type !== 'meta' || last.metaType !== 0x2f)
    out.push(0, 0xff, 0x2f, 0);
  return out;
}

/** Encodes a format 0/1 Standard MIDI File; an end-of-track event is appended when missing. */
export function encodeMidi(file: MidiFile, options: MidiEncodeOptions = {}): Uint8Array {
  const budget = posInt(options.maxEvents, 1_000_000, 'maxEvents');
  if (file.format !== 0 && file.format !== 1) throw new RangeError('format must be 0 or 1');
  if (
    file.tracks.length < 1 ||
    file.tracks.length > 0xffff ||
    (file.format === 0 && file.tracks.length !== 1)
  ) {
    throw new RangeError('invalid track count for format');
  }
  let division: number;
  const d = file.division;
  if (d.type === 'ppq') {
    if (!Number.isInteger(d.ticksPerQuarter) || d.ticksPerQuarter < 1 || d.ticksPerQuarter > 0x7fff)
      throw new RangeError('ticksPerQuarter must be 1..32767');
    division = d.ticksPerQuarter;
  } else {
    if (![24, 25, 29, 30].includes(d.framesPerSecond))
      throw new RangeError('framesPerSecond must be 24, 25, 29 or 30');
    if (!Number.isInteger(d.ticksPerFrame) || d.ticksPerFrame < 1 || d.ticksPerFrame > 255)
      throw new RangeError('ticksPerFrame must be 1..255');
    division = ((256 - d.framesPerSecond) << 8) | d.ticksPerFrame;
  }
  let total = 0;
  const bodies = file.tracks.map((track) => {
    total += track.length;
    if (total > budget) throw new RangeError('too many events');
    return encodeTrack(track, options.runningStatus === true);
  });
  let size = 14;
  for (const body of bodies) size += 8 + body.length;
  if (size > 0xffffffff) throw new RangeError('file too large');
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([0x4d, 0x54, 0x68, 0x64], 0);
  view.setUint32(4, 6, false);
  view.setUint16(8, file.format, false);
  view.setUint16(10, bodies.length, false);
  view.setUint16(12, division, false);
  let at = 14;
  for (const body of bodies) {
    out.set([0x4d, 0x54, 0x72, 0x6b], at);
    view.setUint32(at + 4, body.length, false);
    out.set(body, at + 8);
    at += 8 + body.length;
  }
  return out;
}
