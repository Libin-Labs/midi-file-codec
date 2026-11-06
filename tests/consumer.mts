import {
  MidiError,
  decodeMidi,
  encodeMidi,
  type MidiChannelEvent,
  type MidiEvent,
  type MidiFile,
} from '@lp-labs/midi-file-codec';
const note: MidiChannelEvent = {
  type: 'channel',
  delta: 0,
  kind: 'noteOn',
  channel: 0,
  data1: 60,
  data2: 90,
};
const events: MidiEvent[] = [note, { type: 'meta', delta: 0, metaType: 1, data: new Uint8Array() }];
const file: MidiFile = {
  format: 1,
  division: { type: 'ppq', ticksPerQuarter: 480 },
  tracks: [events],
};
const bytes: Uint8Array = encodeMidi(file, { runningStatus: true });
const decoded: MidiFile = decodeMidi(bytes, { maxEvents: 10 });
const error: MidiError = new MidiError('limit', 'x');
void [decoded.tracks.length, error.offset];
// @ts-expect-error format 2 is not representable
const bad: MidiFile = { format: 2, division: { type: 'ppq', ticksPerQuarter: 1 }, tracks: [] };
// @ts-expect-error unknown channel kind
const kind: MidiChannelEvent = { ...note, kind: 'sustain' };
void [bad, kind];
