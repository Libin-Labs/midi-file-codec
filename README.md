# @lp-labs/midi-file-codec

Bounded Standard MIDI File (format 0 and 1) decoder and encoder: real chunk framing, variable-length quantities, running status, channel/meta/sysex events and strict end-of-track handling. It is a file codec only; there is no synthesizer, player or audio output.

## Install

```sh
npm install @lp-labs/midi-file-codec
```

Node.js 18+; standalone ES2022 core with DOM-library types only. Zero runtime or peer dependencies. ESM and CommonJS builds with separate declarations. No filesystem, network, timer or environment access: every function works on in-memory bytes or strings you provide.

## Quickstart

```js
import { decodeMidi, encodeMidi } from '@lp-labs/midi-file-codec';
const file = {
  format: 0,
  division: { type: 'ppq', ticksPerQuarter: 96 },
  tracks: [
    [
      { type: 'channel', delta: 0, kind: 'noteOn', channel: 0, data1: 60, data2: 100 },
      { type: 'channel', delta: 96, kind: 'noteOff', channel: 0, data1: 60, data2: 0 },
    ],
  ],
};
const bytes = encodeMidi(file, { runningStatus: true });
const decoded = decodeMidi(bytes);
console.log(
  bytes.length,
  decoded.tracks[0].map((event) => event.type + ':' + (event.kind ?? event.metaType)),
);
```

CommonJS consumers use `const api = require('@lp-labs/midi-file-codec')`. The same named API is available in both module formats. No default export.

## API, behavior and options

`decodeMidi(bytes, options?)` returns `{ format, division, tracks }`. `division` is `{ type: 'ppq', ticksPerQuarter }` or `{ type: 'smpte', framesPerSecond: 24|25|29|30, ticksPerFrame }`. Each track is an array of events with `delta` ticks since the previous event; absolute times are left to you (sum the deltas). Events are `channel` (`kind`: noteOff, noteOn, polyPressure, controller, program, channelPressure, pitchBend; `channel` 0-15; raw 7-bit `data1`/`data2`), `meta` (`metaType` + `data` bytes) or `sysex` (`escape` false for F0, true for F7, plus payload bytes). A note-on with velocity 0 stays a note-on. Pitch-bend data bytes are the raw LSB (`data1`) and MSB (`data2`).

Running status is decoded as in the specification: a data byte where a status byte is expected reuses the last channel status; meta and sysex events cancel it. Every decoded track must end with an empty end-of-track meta event (0xFF 0x2F 0x00) that appears exactly once, last. Unknown chunk types are skipped. The header must declare exactly as many `MTrk` chunks as appear. Bytes after the last chunk that do not form a complete chunk header are an error.

`encodeMidi(file, options?)` writes an `MThd` chunk and one `MTrk` per track. An end-of-track event is appended when the track lacks one; one supplied in the middle is rejected. With `runningStatus: true` repeated channel status bytes are omitted (never across meta/sysex events). Delta times and meta/sysex lengths must be integers up to 268,435,455 (four-byte VLQ). Decoding options: `maxBytes` (default 67,108,864), `maxEvents` (default 1,000,000, shared by all tracks).

All exports: `MidiDivision`, `MidiChannelKind`, `MidiChannelEvent`, `MidiMetaEvent`, `MidiSysexEvent`, `MidiEvent`, `MidiFile`, `MidiDecodeOptions`, `MidiEncodeOptions`, `MidiErrorCode`, `MidiError`, `decodeMidi`, `encodeMidi`.

## Full TypeScript declarations

```ts
export type MidiDivision =
  | {
      readonly type: 'ppq';
      readonly ticksPerQuarter: number;
    }
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
export declare class MidiError extends Error {
  readonly code: MidiErrorCode;
  readonly offset: number | undefined;
  constructor(code: MidiErrorCode, message: string, offset?: number);
}
/** Decodes a Standard MIDI File of format 0 or 1. */
export declare function decodeMidi(input: Uint8Array, options?: MidiDecodeOptions): MidiFile;
/** Encodes a format 0/1 Standard MIDI File; an end-of-track event is appended when missing. */
export declare function encodeMidi(file: MidiFile, options?: MidiEncodeOptions): Uint8Array;
```

## Examples

### Absolute ticks and tempo

```js
import { decodeMidi, encodeMidi } from '@lp-labs/midi-file-codec';
const tempo = { type: 'meta', delta: 0, metaType: 0x51, data: Uint8Array.of(0x07, 0xa1, 0x20) }; // 500000 us/quarter
const bytes = encodeMidi({
  format: 1,
  division: { type: 'ppq', ticksPerQuarter: 480 },
  tracks: [[tempo], [{ type: 'channel', delta: 480, kind: 'program', channel: 1, data1: 5 }]],
});
const file = decodeMidi(bytes);
let tick = 0;
for (const event of file.tracks[1]) {
  tick += event.delta;
  console.log(tick, event.type, event.kind ?? event.metaType);
}
const micros = (tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2];
console.log(micros);
```

### Rejecting corrupt input

```js
import { MidiError, decodeMidi } from '@lp-labs/midi-file-codec';
const bytes = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 2, 0, 1, 0, 96]);
try {
  decodeMidi(bytes);
} catch (error) {
  console.log(error instanceof MidiError, error.code);
}
```

## Customization

Limit untrusted input with `maxBytes` and `maxEvents`. Build higher-level models (notes with durations, tempo maps, instrument names) on top of the event arrays; the codec deliberately keeps raw bytes. Choose `runningStatus` on encode to trade a slightly smaller file for maximum reader compatibility (the default writes every status byte).

## Errors

Invalid files throw `MidiError` with `code` (`'truncated'`, `'bad-header'`, `'bad-track'`, `'bad-event'`, `'unsupported'`, `'limit'`) and a byte `offset` where known. Invalid encoder input or limits throw `RangeError`/`TypeError`. Decoding is all-or-nothing.

## Performance

Single pass per track with bounds checks before every read; event payloads are copied, so results never alias the input. Work and memory are linear in input size and capped by `maxEvents`. The encoder builds each track in a number array, which is fine for typical files up to a few million events.

## Scope and non-goals

Supported: format 0 and 1, PPQ and SMPTE divisions, all channel voice messages, meta events (kept as raw bytes), F0/F7 sysex. Not supported (rejected): format 2, system common/real-time status bytes inside tracks, RMID wrappers, XMF. Not provided: playback, synthesis, tempo-map interpretation, quantization or audio rendering. Verified against the worked example in the Standard MIDI Files specification.

## Development

```sh
npm ci --offline
npm run typecheck
npm test
npm run format:check
```

TypeScript ^5.9.3 and Prettier ^3.6.2 are development-only. Build emits dist/esm and dist/cjs. Tests use Node's test runner; consumer.mts and consumer.cts exercise bare package imports including negative type assertions.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
