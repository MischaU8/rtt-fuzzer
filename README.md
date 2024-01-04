# rtt-fuzzer

Fuzzer for [Rally The Troops!](https://rally-the-troops.com/) boardgame rules.

It uses [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js/) as a coverage-guided, in-process fuzzer for node.js.

## What is fuzzing?

Fuzzing or fuzz testing is an automated software testing technique that involves providing invalid, unexpected, or random data as inputs to a computer program. With rtt-fuzzer you can test the rules for any RTT module. It will play random moves and check for unexpected errors.

Currently rtt-fuzzer can detect the following errors:
* A game taking an excessive number of steps, this could indicate infinite loops and other logical flaws in the rules. This is configurable via the `MAX_STEPS` environment variable, set it to a positive value to crash and to a negative value to skip & ignore.
* Dead-end game states where no other actions are available (besides `undo`).
* Any crashes of the rules.js module

## Quickstart

To use `rtt-fuzzer` to fuzz any RTT module follow these few simple steps:

1. Install  dependency

```
npm install
```

2. Start the rtt-module fuzzer:

```
RTT_RULES=../server/public/field-cloth-gold/rules.js npx jazzer rtt-module
```

You can specify the RTT `rules.js` file with the `RTT_RULES` environment variable, it uses `rules.js` from the current directory by default.

3. Enjoy fuzzing!

## Example output

The following output shows a potential bug in the `move_persian_army` function of `300-earth-and-water/rules.js`:

```
$ RTT_RULES=../server/public/300-earth-and-water/rules.js npx jazzer rtt-module
Loading rtt-fuzzer RTT_RULES='../server/public/300-earth-and-water/rules.js' with MAX_STEPS=2048
INFO: New number of coverage counters 1024
INFO: New number of coverage counters 2048
Dictionary: 4 entries
INFO: Running with entropic power schedule (0xFF, 100).
INFO: Seed: 1668133216
INFO: Loaded 3 modules   (2048 inline 8-bit counters): 512 [0x148050000, 0x148050200), 512 [0x148050200, 0x148050400), 1024 [0x148050400, 0x148050800),
INFO: Loaded 3 PC tables (2048 PCs): 512 [0x1124b4000,0x1124b6000), 512 [0x1124b6000,0x1124b8000), 1024 [0x1124b8000,0x1124bc000),
INFO: -max_len is not provided; libFuzzer will not generate inputs larger than 4096 bytes

GAME { seed: 1, scenario: 'Standard', options: {} }
VIEW {
  log: [
    'Start Campaign 1',
    '',
    'Persian Preparation Phase',
    'Persia bought 6 cards.',
    'Persia raised:\n 6 armies in Abydos',
    '.hr',
    'Greek Preparation Phase',
    'Greece bought 6 cards.',
    'Greece raised:\nnothing.',
    '.hr',
    'Persia played card 10 for movement.',
    'Persia moved p armies:\nAbydos to E.'
  ],
  active: 'Persia',
  campaign: 1,
  vp: 0,
  trigger: {
    darius: 0,
    xerxes: 0,
    artemisia: 0,
    miltiades: 0,
    themistocles: 0,
    leonidas: 0,
    hellespont: 0,
    carneia_festival: 0,
    acropolis_on_fire: 0
  },
  units: {
    Abydos: [ 0, NaN, 0, 0 ],
    Athenai: [ 1, 0, 1, 0 ],
    Delphi: [ 0, 0 ],
    Ephesos: [ 0, 2, 0, 1 ],
    Eretria: [ 0, 0, 0, 0 ],
    Korinthos: [ 1, 0 ],
    Larissa: [ 0, 0 ],
    Naxos: [ 0, 0, 0, 0 ],
    Pella: [ 0, 0, 0, 0 ],
    Sparta: [ 1, 0, 1, 0 ],
    Thebai: [ 0, 0, 0, 0 ],
    reserve: [ 6, 14, 3, 5 ]
  },
  g_cards: 6,
  p_cards: 5,
  discard: 10,
  deck_size: 4,
  discard_size: 1,
  prompt: 'Persian Land Movement: Select armies to move and then a destination.',
  land_movement: 'Abydos',
  actions: { city: [ 'Ephesos' ] },
  hand: [ 4, 1, 8, 2, 3 ],
  draw: 0
}
STEP=24 ACTIVE=Persia ACTION: city "Ephesos"
STATE dumped to 'crash-state.json'

==63262== Uncaught Exception: Jazzer.js: TypeError: Cannot read properties of undefined (reading '1')
TypeError: Cannot read properties of undefined (reading '1')
    at move_persian_army /home/user/projects/rtt/server/public/300-earth-and-water/rules.js:448:12)
    at Object.city (/home/user/projects/rtt/server/public/300-earth-and-water/rules.js:1159:3)
    at Object.action (/home/user/projects/rtt/server/public/300-earth-and-water/rules.js:3448:12)
    at module.exports.fuzz (/home/user/projects/rtt/rtt-fuzzer/rtt-module.js:65:27)
    at result (/home/user/projects/rtt/rtt-fuzzer/node_modules/@jazzer.js/core/core.ts:357:15)
MS: 0 ; base unit: 0000000000000000000000000000000000000000


artifact_prefix='./'; Test unit written to ./crash-da39a3ee5e6b4b0d3255bfef95601890afd80709
Base64:
```

## What does the status output mean?

```
#2	INITED cov: 387 ft: 387 corp: 1/1b exec/s: 0 rss: 151Mb
#3	NEW    cov: 408 ft: 490 corp: 2/2b lim: 4 exec/s: 0 rss: 151Mb L: 1/1 MS: 1 ChangeBinInt-
#4	NEW    cov: 412 ft: 532 corp: 3/3b lim: 4 exec/s: 0 rss: 151Mb L: 1/1 MS: 1 ChangeBinInt-
#6	NEW    cov: 417 ft: 555 corp: 4/5b lim: 4 exec/s: 0 rss: 151Mb L: 2/2 MS: 2 ShuffleBytes-InsertByte-
```

See the LibFuzzer documentation for more details on the output
https://llvm.org/docs/LibFuzzer.html#output
