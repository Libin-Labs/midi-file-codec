import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MidiError, decodeMidi, encodeMidi } from '../dist/esm/index.js';

// The worked example from the Standard MIDI Files 1.0 specification (format 0, 96 ticks per quarter),
// which uses running status, a two-byte delta (81 40 = 192) and meta events.
const SPEC_EXAMPLE =
  '4d546864000000060000000100604d54726b0000003b00ff58040402180800ff510307a12000c00500c12e00c24600923060003c606091434060904c208140823040003c400081434000804c4000ff2f00';
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const ch = (delta, kind, channel, data1, data2) =>
  data2 === undefined
    ? { type: 'channel', delta, kind, channel, data1 }
    : { type: 'channel', delta, kind, channel, data1, data2 };
const header = (format, tracks, division) => [
  0x4d,
  0x54,
  0x68,
  0x64,
  0,
  0,
  0,
  6,
  0,
  format,
  0,
  tracks,
  division >> 8,
  division & 255,
];
const track = (...body) => [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length, ...body];

test('decodes the specification example including running status and VLQ', () => {
  const file = decodeMidi(bytes(SPEC_EXAMPLE));
  assert.equal(file.format, 0);
  assert.deepEqual(file.division, { type: 'ppq', ticksPerQuarter: 96 });
  const events = file.tracks[0];
  assert.equal(events.length, 14);
  assert.deepEqual(events[0], {
    type: 'meta',
    delta: 0,
    metaType: 0x58,
    data: Uint8Array.of(4, 2, 0x18, 8),
  });
  assert.deepEqual(events[1].data, Uint8Array.of(0x07, 0xa1, 0x20));
  assert.deepEqual(events[2], ch(0, 'program', 0, 5));
  assert.deepEqual(events[5], ch(0, 'noteOn', 2, 0x30, 0x60));
  assert.deepEqual(events[6], ch(0, 'noteOn', 2, 0x3c, 0x60)); // running status
  assert.deepEqual(events[9], ch(192, 'noteOff', 2, 0x30, 0x40));
  assert.deepEqual(events[10], ch(0, 'noteOff', 2, 0x3c, 0x40)); // running status
  assert.deepEqual(events[13], { type: 'meta', delta: 0, metaType: 0x2f, data: new Uint8Array() });
});

test('re-encoding with running status reproduces the specification bytes exactly', () => {
  const file = decodeMidi(bytes(SPEC_EXAMPLE));
  assert.deepEqual(encodeMidi(file, { runningStatus: true }), bytes(SPEC_EXAMPLE));
  const explicit = encodeMidi(file);
  assert.ok(explicit.length > SPEC_EXAMPLE.length / 2);
  assert.deepEqual(decodeMidi(explicit), file);
});

test('VLQ boundaries round-trip and match the specification table', () => {
  const table = [
    [0, [0]],
    [0x7f, [0x7f]],
    [0x80, [0x81, 0]],
    [0x2000, [0xc0, 0]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x81, 0x80, 0]],
    [0x1fffff, [0xff, 0xff, 0x7f]],
    [0x200000, [0x81, 0x80, 0x80, 0]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ];
  for (const [delta, vlq] of table) {
    const encoded = encodeMidi({
      format: 0,
      division: { type: 'ppq', ticksPerQuarter: 480 },
      tracks: [[ch(delta, 'noteOn', 0, 60, 1)]],
    });
    assert.deepEqual([...encoded.slice(22, 22 + vlq.length)], vlq);
    assert.equal(decodeMidi(encoded).tracks[0][0].delta, delta);
  }
  assert.throws(
    () =>
      encodeMidi({
        format: 0,
        division: { type: 'ppq', ticksPerQuarter: 1 },
        tracks: [[ch(0x10000000, 'noteOn', 0, 1, 1)]],
      }),
    RangeError,
  );
});

test('format 1 multi-track, SMPTE division, sysex, escape and unknown chunks', () => {
  const smpte = ((256 - 25) << 8) | 40;
  const data = [
    ...header(1, 2, smpte),
    ...[0x58, 0x58, 0x58, 0x58, 0, 0, 0, 3, 1, 2, 3], // unknown chunk is skipped
    ...track(
      0,
      0xff,
      0x03,
      2,
      0x41,
      0x42,
      5,
      0xf0,
      3,
      1,
      2,
      0xf7,
      0,
      0xf7,
      2,
      9,
      9,
      0,
      0xff,
      0x2f,
      0,
    ),
    ...track(0, 0xe0, 0x01, 0x40, 0, 0xd1, 0x7f, 0, 0xff, 0x2f, 0),
  ];
  const file = decodeMidi(Uint8Array.from(data));
  assert.deepEqual(file.division, { type: 'smpte', framesPerSecond: 25, ticksPerFrame: 40 });
  assert.equal(file.tracks.length, 2);
  assert.deepEqual(file.tracks[0][1], {
    type: 'sysex',
    delta: 5,
    escape: false,
    data: Uint8Array.of(1, 2, 0xf7),
  });
  assert.deepEqual(file.tracks[0][2], {
    type: 'sysex',
    delta: 0,
    escape: true,
    data: Uint8Array.of(9, 9),
  });
  assert.deepEqual(file.tracks[1][0], ch(0, 'pitchBend', 0, 1, 0x40));
  assert.deepEqual(file.tracks[1][1], ch(0, 'channelPressure', 1, 0x7f));
  assert.deepEqual(decodeMidi(encodeMidi(file)), file);
});

test('running status is cancelled by meta and sysex events', () => {
  const body = [0, 0x90, 60, 64, 0, 0xff, 0x01, 0, 0, 61, 64, 0, 0xff, 0x2f, 0];
  assert.throws(
    () => decodeMidi(Uint8Array.from([...header(0, 1, 96), ...track(...body)])),
    (e) => e instanceof MidiError && e.code === 'bad-event',
  );
  const sysex = [0, 0x90, 60, 64, 0, 0xf0, 0, 0, 61, 64, 0, 0xff, 0x2f, 0];
  assert.throws(
    () => decodeMidi(Uint8Array.from([...header(0, 1, 96), ...track(...sysex)])),
    MidiError,
  );
  const file = decodeMidi(
    Uint8Array.from([...header(0, 1, 96), ...track(0, 0x90, 60, 64, 0, 61, 64, 0, 0xff, 0x2f, 0)]),
  );
  const withMeta = {
    ...file,
    tracks: [
      [
        ch(0, 'noteOn', 0, 60, 64),
        { type: 'meta', delta: 0, metaType: 1, data: new Uint8Array() },
        ch(0, 'noteOn', 0, 61, 64),
      ],
    ],
  };
  const encoded = encodeMidi(withMeta, { runningStatus: true });
  assert.equal(encoded.filter((b) => b === 0x90).length, 2);
  assert.deepEqual(decodeMidi(encoded).tracks[0].length, 4);
});

test('malformed headers and unsupported variants are rejected explicitly', () => {
  const ok = track(0, 0xff, 0x2f, 0);
  const cases = [
    [header(2, 1, 96).concat(ok), 'unsupported'],
    [header(3, 1, 96).concat(ok), 'bad-header'],
    [header(0, 2, 96).concat(ok, ok), 'bad-header'],
    [header(1, 0, 96), 'bad-header'],
    [header(1, 1, 0).concat(ok), 'bad-header'],
    [header(1, 1, ((256 - 20) << 8) | 4).concat(ok), 'bad-header'],
    [header(1, 1, 0x8000 | (231 << 8) | 0).concat(ok), 'bad-header'],
    [header(1, 2, 96).concat(ok), 'bad-track'],
    [header(1, 1, 96).concat(ok, ok), 'bad-track'],
    [[0x52, 0x49, 0x46, 0x46, ...new Array(12).fill(0)], 'bad-header'],
    [[...header(0, 1, 96)].map((b, i) => (i === 7 ? 2 : b)).concat(ok), 'bad-header'],
  ];
  for (const [data, code] of cases) {
    assert.throws(
      () => decodeMidi(Uint8Array.from(data)),
      (e) => e instanceof MidiError && e.code === code,
      code,
    );
  }
});

test('malformed tracks fail with MidiError and never read out of bounds', () => {
  const t = (...body) => Uint8Array.from([...header(0, 1, 96), ...track(...body)]);
  const bad = [
    t(0, 0x90, 60), // truncated channel event
    t(0, 0x90, 60, 200, 0, 0xff, 0x2f, 0), // data byte high bit
    t(0, 0xff, 0x01, 5, 65, 0, 0xff, 0x2f, 0), // meta length overruns
    t(0, 0xf0, 9, 1, 0xff, 0x2f, 0), // sysex length overruns
    t(0x80, 0x80, 0x80, 0x80, 0, 0xff, 0x2f, 0), // 5-byte VLQ
    t(0x81), // VLQ runs off the track
    t(0), // delta with no status
    t(0, 0xff, 0x2f, 0, 0, 0xff, 0x2f, 0), // end of track not last
    t(0, 0xff, 0x2f, 1, 0), // end of track with data
    t(0, 0x90, 60, 64), // missing end of track
    t(), // empty track
    t(0, 0xf8), // realtime status
    t(0, 0xf1, 0), // system common
    t(0, 60, 64, 0, 0xff, 0x2f, 0), // data byte without running status
    t(0, 0xff, 0xf0, 0, 0, 0xff, 0x2f, 0), // meta type > 127
  ];
  for (const input of bad) assert.throws(() => decodeMidi(input), MidiError);
  const good = t(0, 0x90, 60, 64, 0, 0xff, 0x2f, 0);
  for (let n = 0; n < good.length; n++)
    assert.throws(() => decodeMidi(good.slice(0, n)), MidiError, `prefix ${n}`);
  const huge = good.slice();
  new DataView(huge.buffer).setUint32(18, 0xffffffff, false);
  assert.throws(
    () => decodeMidi(huge),
    (e) => e.code === 'truncated',
  );
  assert.throws(
    () => decodeMidi(good, { maxBytes: 10 }),
    (e) => e.code === 'limit',
  );
  assert.throws(
    () => decodeMidi(good, { maxEvents: 1 }),
    (e) => e.code === 'limit',
  );
});

test('encoder validates events and appends end-of-track', () => {
  const base = { format: 0, division: { type: 'ppq', ticksPerQuarter: 96 } };
  const one = (event) => ({ ...base, tracks: [[event]] });
  assert.throws(() => encodeMidi(one(ch(0, 'noteOn', 16, 1, 1))), RangeError);
  assert.throws(() => encodeMidi(one(ch(0, 'noteOn', 0, 128, 1))), RangeError);
  assert.throws(() => encodeMidi(one(ch(0, 'noteOn', 0, 1))), RangeError);
  assert.throws(() => encodeMidi(one(ch(0, 'program', 0, 1, 2))), RangeError);
  assert.throws(() => encodeMidi(one(ch(0, 'bogus', 0, 1, 2))), RangeError);
  assert.throws(() => encodeMidi(one(ch(-1, 'noteOn', 0, 1, 1))), RangeError);
  assert.throws(() => encodeMidi(one(ch(1.5, 'noteOn', 0, 1, 1))), RangeError);
  assert.throws(
    () => encodeMidi(one({ type: 'meta', delta: 0, metaType: 0x2f, data: Uint8Array.of(1) })),
    RangeError,
  );
  assert.throws(
    () =>
      encodeMidi({
        ...base,
        tracks: [
          [
            { type: 'meta', delta: 0, metaType: 0x2f, data: new Uint8Array() },
            ch(0, 'noteOn', 0, 1, 1),
          ],
        ],
      }),
    RangeError,
  );
  assert.throws(() => encodeMidi({ ...base, format: 0, tracks: [[], []] }), RangeError);
  assert.throws(() => encodeMidi({ ...base, format: 2, tracks: [[]] }), RangeError);
  assert.throws(() => encodeMidi({ ...base, tracks: [] }), RangeError);
  assert.throws(
    () => encodeMidi({ ...base, division: { type: 'ppq', ticksPerQuarter: 0x8000 }, tracks: [[]] }),
    RangeError,
  );
  assert.throws(
    () =>
      encodeMidi({
        ...base,
        division: { type: 'smpte', framesPerSecond: 28, ticksPerFrame: 4 },
        tracks: [[]],
      }),
    RangeError,
  );
  assert.throws(
    () =>
      encodeMidi(
        { ...base, tracks: [[ch(0, 'noteOn', 0, 1, 1), ch(0, 'noteOn', 0, 1, 1)]] },
        { maxEvents: 1 },
      ),
    RangeError,
  );
  const empty = encodeMidi({ ...base, tracks: [[]] });
  assert.deepEqual([...empty.slice(14)], [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0]);
  assert.throws(() => decodeMidi('x'), TypeError);
});
