#!/usr/bin/env python3
import base64
import json
import os
import re
import shlex
import signal
import subprocess
import sys


LEDGER = os.environ.get("ORCA_STA4593_LEDGER", "/tmp/sta4593-codex.jsonl")


def record(event, **fields):
    with open(LEDGER, "a", encoding="ascii") as ledger:
        ledger.write(json.dumps({"event": event, "pid": os.getpid(), **fields}) + "\n")


if "app-server" in sys.argv[1:]:
    sys.stderr.write("error: unrecognized subcommand 'app-server'\n")
    sys.stderr.flush()
    sys.exit(2)


def finish(signum, _frame):
    record("signal", signal=signum)
    sys.exit(128 + signum)


signal.signal(signal.SIGTERM, finish)
signal.signal(signal.SIGINT, finish)
terminal_handle = os.environ.get("ORCA_TERMINAL_HANDLE")
record(
    "started",
    argv=sys.argv[1:],
    terminal=terminal_handle,
    ppid=os.getppid(),
)
if not terminal_handle:
    record("missing_terminal_handle")
    sys.exit(2)
sys.stdout.write("\x1b]0;Codex Ready\x07OpenAI Codex\nmodel: sta4593-oracle\ndirectory: wsl\n")
sys.stdout.flush()

buffer = b""
capability = None
acknowledged = False
handled = set()

while True:
    try:
        chunk = os.read(sys.stdin.fileno(), 4096)
    except OSError as error:
        record("stdin_error", errno=error.errno)
        break
    if not chunk:
        record("stdin_closed")
        break
    buffer = (buffer + chunk)[-131072:]
    if capability is None:
        match = re.search(rb"--dispatch-capability (dcap_[A-Za-z0-9_-]+)", buffer)
        if match:
            capability = match.group(1).decode("ascii")
            record("capability_received", capability=capability)
    submitted = b"\x1b[201~\r" in buffer or b"\x1b[201~\n" in buffer
    if capability and not acknowledged and submitted:
        acknowledged = True
        record("prompt_submitted")
        sys.stdout.write("\x1b]0;Codex working\x07STA4593_INJECTION_ACK\n")
        sys.stdout.flush()

    for match in re.finditer(rb"STA4593_DONE:([A-Za-z0-9+/=]+)", buffer):
        encoded = match.group(1)
        if encoded in handled or capability is None:
            continue
        handled.add(encoded)
        request = json.loads(base64.b64decode(encoded).decode("ascii"))
        command = shlex.split(
            os.environ.get(
                "ORCA_CLI_COMMAND",
                "/home/orca/squashfs-root/resources/bin/orca-ide",
            )
        )
        command.extend(
            [
                "orchestration",
                "send",
                "--from",
                "term_sta4593_foreign"
                if request.get("mismatch")
                else terminal_handle,
                "--dispatch-capability",
                capability,
                "--type",
                "worker_done",
                "--subject",
                "wrong sender" if request.get("mismatch") else "completed",
                "--body",
                "STA-4593 federated lifecycle oracle.",
                "--task-id",
                request["taskId"],
                "--dispatch-id",
                request["dispatchId"],
                "--outcome",
                "succeeded",
                "--json",
            ]
        )
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        record(
            "worker_done",
            mismatch=bool(request.get("mismatch")),
            status=result.returncode,
            stdout=result.stdout,
            stderr=result.stderr,
        )
        sys.stdout.write(
            "STA4593_DONE_RESULT|{}|{}\n".format(
                "mismatch" if request.get("mismatch") else "valid",
                result.returncode,
            )
        )
        sys.stdout.flush()

    exit_match = re.search(rb"STA4593_EXIT:([A-Za-z0-9_-]+)", buffer)
    if exit_match:
        marker = exit_match.group(1).decode("ascii")
        record("exit_marker", marker=marker)
        sys.stdout.write(f"STA4593_STDOUT|{marker}|FINAL\n")
        sys.stderr.write(f"STA4593_STDERR|{marker}|FINAL\n")
        sys.stdout.flush()
        sys.stderr.flush()
        try:
            os.kill(os.getppid(), signal.SIGTERM)
        except ProcessLookupError:
            pass
        sys.exit(23)
