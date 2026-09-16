# relay-bench

Measures how long a phone takes to reach a usable connection with a desktop over the production
relay, without building or instrumenting the mobile app.

`relay-phone-connect-bench.mjs` replays the shipped mobile wire sequence: the relay auth frame,
the E2EE v2 handshake with the same transcript encoding and HKDF key schedule the app uses, then
the RPCs the phone issues before it publishes `connected`. Because it is the real sequence against
a real desktop, the per-phase numbers attribute latency to a specific hop rather than to "connect".

The handshake itself lives in `phone-e2ee-v2-session.mjs`, a plain-JS port of the mobile client
session so it runs outside the React Native bundle.
`phone-e2ee-desktop-parity.test.mjs` pins that port to the desktop responder
in `src/main/runtime/rpc/mobile-e2ee-v2-desktop-session.ts`. It runs in the normal unit suite, so
a change to the transcript encoding, key schedule, or frame layout fails there instead of leaving
a bench that quietly measures a handshake nobody ships. The four other `*.test.mjs` files in this
directory cover the invocation guards, the state file, the region verdicts, and pairing-link
decoding, and none of them opens a socket.

## Security rules

- The pairing link contains a live invite token and a device token. Treat it as a credential. `pair`
  reads it from stdin, or from a file named by `--pairing-url-file`, so it never reaches your shell
  history or the process argument list. Passing it as an argument is refused.
- `state.json` holds the resume token and device token for a real paired desktop. Never commit it,
  paste it, or attach it to an issue. The `.gitignore` in this directory blocks `*.json` and
  `state*`, but do not rely on that alone.
- Revoke the bench device when you are done. See "Cleaning up" below.
- Do not point the bench at a desktop you do not own.

No script here has a production default. Every one of them refuses to open a socket unless
`ORCA_RELAY_BENCH_LIVE=1` is set, and the two that talk to the director require its origin from
`--director=<origin>` or `ORCA_RELAY_BENCH_DIRECTOR`. Without those, they print usage and exit 2.
That keeps an accidental or automated invocation inert instead of live traffic.

The guards are in `relay-bench-invocation.mjs` and `relay-bench-state-file.mjs`, and
`relay-bench-invocation.test.mjs` / `relay-bench-state-file.test.mjs` pin them:

| Guard                     | What it stops                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| https-only origins        | An `http:` director or cell, where an on-path observer reads bench credentials                                                      |
| Public-destination check  | A director aiming the harness at your loopback, link-local, or private network, by literal address or by a name that resolves there |
| Bounded integer arguments | `--runs=Infinity` and friends, which loop forever and generate relay traffic                                                        |
| `0600` state file         | An existing state file staying group- or world-readable, or being a symlink                                                         |

A director you name also _supplies_ URLs: the region catalog's probe origins and the cell URL from
`/v1/resolve`. Those go through the same public-https check as an origin you typed, so a compromised
or spoofed director cannot turn the harness into a probe of your own network. Region entries whose
probe origins are all refused report `REFUSED (no allowed probe origin)` rather than being sampled.
Hostnames are also resolved and checked, which narrows but does not close the DNS rebinding window,
because `fetch()` resolves again.

State-file handling creates the parent directory before writing, refuses a symlink, and forces
`0600` on an existing file. The first of those matters most: `pair` writes only after the desktop
has already provisioned the resume credential, so a failed write loses it.

## Requirements

`ws` and `tweetnacl` resolve from the repo root `node_modules`. Measured against `ws` 8.21.3 and
`tweetnacl` 1.0.3. Run every command from the repo root.

Syntax check after editing:

```bash
for f in tests/tools/relay-bench/*.mjs; do node --check "$f"; done
npx vitest run --config config/vitest.config.ts tests/tools/relay-bench
```

## Getting a pairing link

Start a relay-enabled dev app hidden, with remote debugging on:

```bash
ORCA_BACKGROUND_LAUNCH=1 \
REMOTE_DEBUGGING_PORT=9222 \
ORCA_CLOUD_API_URL=https://login.onorca.dev \
ORCA_CLOUD_CLIENT_ID=orca-desktop \
ORCA_DEV_USER_DATA_PATH=/tmp/orca-relay-bench-profile \
ORCA_RELAY_REGION_OVERRIDE=us-central1 \
pnpm run dev
```

`ORCA_DEV_USER_DATA_PATH` keeps the bench pairing out of your real profile.
`ORCA_RELAY_REGION_OVERRIDE` pins the cell region, which is what you want when comparing a change
rather than comparing regions. Both are optional.

Sign in, then read the pairing offer out of the hidden renderer:

```bash
node tests/tools/relay-bench/cdp-eval.mjs 9222 'window.api.mobile.getPairingQR({})'
```

The `orca://pair?code=...` value in that output is the pairing link.

## Commands

```bash
export ORCA_RELAY_BENCH_LIVE=1
BENCH=tests/tools/relay-bench/relay-phone-connect-bench.mjs

# One-time: dial the invite, provision a resume credential, save the bundle. The pairing link
# comes in on stdin so it stays out of your shell history and out of `ps`.
pbpaste | node $BENCH pair /tmp/relay-bench/state.json

# Or from a file you protect yourself, which `pair` requires to be mode 0600:
umask 077 && printf '%s' '<orca://pair?code=...>' > /tmp/relay-bench/pair.txt
node $BENCH pair /tmp/relay-bench/state.json --pairing-url-file=/tmp/relay-bench/pair.txt
rm /tmp/relay-bench/pair.txt

# Steady-state foreground reconnect, 10 times, 2 s apart, re-resolving the cell each time.
node $BENCH run /tmp/relay-bench/state.json 10 --resolve --gap=2000

# Resume after background: connect, idle 45 s, then probe the retained socket.
node $BENCH foreground /tmp/relay-bench/state.json --hold=45000

# Same, but crossing the relay's ~105 s client silence watchdog.
node $BENCH foreground /tmp/relay-bench/state.json --hold=120000
```

On Linux or Windows, replace `pbpaste` with whatever prints the link to stdout, or use
`--pairing-url-file`. Every count and duration is a whole number: `runs` and `--rounds` are 1-1000,
`--gap` and `--hold` are 0-3600000 ms, and anything else exits 2 rather than running unbounded.

The bench reads the director and cell for a resume dial out of `state.json`, which the pairing
offer supplied, so it takes no `--director`.

`run` prints one JSON row per iteration plus a `SUMMARY` line with medians.

`foreground` prints a single JSON row. Flags:

| Flag             | Default | Meaning                                                        |
| ---------------- | ------- | -------------------------------------------------------------- |
| `--hold=ms`      | `45000` | Idle time with no application traffic after reaching connected |
| `--force-redial` | off     | Redial even when the retained socket answered                  |
| `--resolve`      | off     | Re-resolve the cell through the director before each dial      |

It adds two fields to the per-phase shape. `retainedAnswerMs` is how long the held-open socket took
to answer `status.get`, or `null` if it could not. `redialMs` is the wall clock for a full resume
redial through the same connected sequence, measured on failure or with `--force-redial`.
`closedDuringHold` carries the close code if the relay dropped the socket while it was idle.

Note that the WebSocket library answers protocol-level pings automatically, exactly as the phone's
socket does. The silence watchdog counts application traffic, not pongs.

Two supporting scripts:

- `relay-hop-latency.mjs --cell=<origin> --director=<origin> [--host=<relayHostId>] [--runs=N]`
  measures the infrastructure floor with a throwaway credential: director `/v1/resolve` plus cell
  WebSocket open to `relay-hello`. It needs no pairing, because a cell answers a bogus credential
  without reaching a desktop. `--host` defaults to an id no desktop owns. `openMs` is `null` when
  the socket never opened, and a director that stalls is reported as a resolve timeout rather than
  hanging the run loop.
- `region-probe-replay.mjs --director=<origin> [--rounds=N]` replays the desktop's region
  selection with the same probe, sample count, and spread rule, and prints why each region passed
  or failed. A region whose every probe fails reports `UNREACHABLE`, not `ok`.

Both take the director from `--director` or `ORCA_RELAY_BENCH_DIRECTOR`, and both need
`ORCA_RELAY_BENCH_LIVE=1`:

```bash
ORCA_RELAY_BENCH_LIVE=1 ORCA_RELAY_BENCH_DIRECTOR=<director origin> \
  node tests/tools/relay-bench/region-probe-replay.mjs --rounds=3
```

## What each phase means

| Phase               | Measures                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| `wsOpen`            | DNS, TCP, and TLS to the cell, up to the WebSocket upgrade                           |
| `relayHello`        | Cell-side credential validation and the desktop-side attach, ending at `relay-hello` |
| `e2eeReady`         | Desktop's `e2ee_ready`, so one relay round trip plus the desktop's key generation    |
| `e2eeAuthenticated` | Device-token check on the desktop, ending the handshake                              |
| `confirm`           | `pairing.getEndpoints` with the resume confirm id, which settles the credential      |
| `capabilities`      | The client capability advisory the phone sends before publishing connected           |
| `status.get`        | The first RPC the UI gate blocks on                                                  |
| `worktree.ps`       | The worktree catalog, and the largest payload in the sequence                        |
| `session.tabs.list` | Per-worktree tab list for the first worktree                                         |
| `terminal.list`     | Per-worktree terminal list for the first worktree                                    |

`totalToConnectedMs` is `e2eeAuthenticated` plus `confirm` plus `capabilities`.
`totalToFirstTerminalListMs` is the whole sequence.

## Reference numbers

Measured 2026-09-07 from a US-East vantage, same desktop and identical sequence, differing only in
which cell region served the connection. The vantage matters: these are not what a phone next to
the desktop would see.

| Cell region | To connected | `relayHello` | `confirm` |
| ----------- | ------------ | ------------ | --------- |
| Asia        | 10.5 s       | 5.8 s        | 3.4 s     |
| US          | 0.63 s       | 0.29 s       | 0.14 s    |

## Cleaning up

Revoke the bench device from the desktop that granted it:

```bash
node tests/tools/relay-bench/cdp-eval.mjs 9222 'window.api.mobile.revokeDevice({ deviceId: "<id>" })'
```

If you do not know the id, list the paired devices first:

```bash
node tests/tools/relay-bench/cdp-eval.mjs 9222 'window.api.mobile.listDevices()'
```

Then delete `state.json`. If you used
`ORCA_DEV_USER_DATA_PATH`, removing that directory drops the pairing with it.
