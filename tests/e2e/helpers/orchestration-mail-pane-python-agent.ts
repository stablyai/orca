export const MAIL_PANE_PYTHON_AGENT_SOURCE = String.raw`
import json
import os
import subprocess
import sys
import threading
import time
import tty

ledger_path, title_path, control_path, cli_command = sys.argv[1:5]
ledger_lock = threading.Lock()

def log(value):
    with ledger_lock:
        with open(ledger_path, 'a', encoding='utf-8') as ledger:
            ledger.write(json.dumps(value, separators=(',', ':')) + '\n')

log({
    'event': 'start',
    'hasLaunchToken': bool(os.environ.get('ORCA_AGENT_LAUNCH_TOKEN')),
    'terminalHandle': os.environ.get('ORCA_TERMINAL_HANDLE'),
    'wslDistro': os.environ.get('WSL_DISTRO_NAME'),
})
print('GOLDEN_STUB_AGENT_READY', flush=True)

def poll_controls():
    last_title = None
    last_control_stamp = None
    while True:
        try:
            with open(title_path, encoding='utf-8') as title_file:
                title = title_file.read()
        except FileNotFoundError:
            title = ''
        if title and title != last_title:
            sys.stdout.write('\x1b]0;' + title + '\x07')
            sys.stdout.flush()
            last_title = title
        try:
            stamp = os.stat(control_path).st_mtime_ns
        except FileNotFoundError:
            stamp = None
        if stamp is not None and stamp != last_control_stamp:
            last_control_stamp = stamp
            try:
                with open(control_path, encoding='utf-8') as control_file:
                    request = json.load(control_file)
                log({'event': 'cli-start', 'requestId': request['requestId'], 'cliCommand': cli_command})
                result = subprocess.run(
                    [cli_command, *request['args']],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    env={**os.environ, 'ORCA_DEV_CLI_INVOCATION': '1'},
                )
                log({
                    'event': 'cli-result',
                    'requestId': request['requestId'],
                    'status': result.returncode,
                    'stdout': result.stdout,
                    'stderr': result.stderr,
                })
            except Exception as error:
                log({
                    'event': 'cli-error',
                    'requestId': request.get('requestId') if 'request' in locals() else None,
                    'error': str(error),
                })
        time.sleep(0.025)

threading.Thread(target=poll_controls, daemon=True).start()
tty.setraw(sys.stdin.fileno())
while True:
    value = os.read(sys.stdin.fileno(), 4096)
    if not value:
        break
    log({'event': 'stdin', 'data': value.decode('utf-8', errors='replace')})
`
