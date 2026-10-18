# Water and bird audio

Real recordings, not synthesis. From Mixkit, whose licence allows free use in
commercial and non-commercial projects with no attribution required
(https://mixkit.co/license/).

| file | source | what it is |
|---|---|---|
| `water-bed.mp3` | Mixkit 2454 (rivers) | 45 s seamless loop, cut calm: low-passed at 2.4 kHz and high-passed at 90 Hz, loudness-normalised to -27 LUFS, last 2 s crossfaded into the first 2 s |
| `bird-1..4.mp3` | Mixkit 2467 (a quiet morning) | four single bird calls cut at their onsets, 1.1 s each, -22 LUFS, faded at the tail so a cut never clicks |

The pond plays the bed low and continuous, then drops a single bird call every
11 to 31 seconds at a random side and a slight random pitch. There are no click,
splash or gulp sounds: those events are silent on purpose.

Rebuild:
- bed: `-ss 12 -t 47` from the source, then crossfade 45:47 into 0:2
- birds: high-pass the source at 1.8 kHz, take the four strongest onsets over
  0.9 s apart, cut 1.1 s from 80 ms before each
