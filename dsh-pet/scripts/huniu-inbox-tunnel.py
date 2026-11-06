"""Hidden launcher for the dsh-pet 虎妞 inbox tunnel (alias dsh-pet-huniu) only.

Waits for the fish's loopback MCP inbox (127.0.0.1:18781), then runs the official
`tunnel-client runtimes connect` with the runtime key by `file:` reference and the inbox
bearer injected through an environment-referenced header. Idempotent: connect reuses a
running alias, so the scheduled task may re-run it to self-heal. Never prints or stores
credentials or tunnel diagnostics; writes only a public status file.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

ALIAS = 'dsh-pet-huniu'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--tunnel-exe', required=True)
    p.add_argument('--profile-dir', required=True)
    p.add_argument('--tunnel-key-file', required=True)
    p.add_argument('--inbox-key-file', required=True)
    p.add_argument('--tunnel-id', required=True)
    p.add_argument('--workspace-id', required=True)
    p.add_argument('--status-file', required=True)
    p.add_argument('--port', type=int, default=18781)
    args = p.parse_args()
    for _ in range(120):
        try:
            with socket.create_connection(('127.0.0.1', args.port), timeout=1):
                break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError('inbox_not_listening')
    bearer = Path(args.inbox_key_file).read_text(encoding='ascii').strip()
    if len(bearer) != 64:
        raise RuntimeError('invalid_inbox_key')
    env = dict(os.environ)
    env['DSH_PET_HUNIU_AUTHORIZATION'] = 'Bearer ' + bearer
    env['MCP_EXTRA_HEADERS'] = 'Authorization: env:DSH_PET_HUNIU_AUTHORIZATION'
    env['HEALTH_LISTEN_ADDR'] = '127.0.0.1:18782'
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    command = [args.tunnel_exe, 'runtimes', 'connect', '--alias', ALIAS,
               '--profile', ALIAS, '--profile-dir', args.profile_dir,
               '--tunnel-id', args.tunnel_id, '--workspace-id', args.workspace_id,
               '--mcp-server-url', 'http://127.0.0.1:' + str(args.port) + '/mcp',
               '--runtime-api-key', 'file:' + args.tunnel_key_file, '--json']
    result = subprocess.run(command, env=env, capture_output=True, timeout=120, creationflags=flags,
                            stdin=subprocess.DEVNULL, check=False)
    try:
        status = json.loads(result.stdout)
    except ValueError:
        status = {}
    public = {k: status.get(k) for k in ['alias', 'process_running', 'healthy', 'ready', 'runtime_state']}
    public['exit_code'] = result.returncode
    public['at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    Path(args.status_file).write_text(json.dumps(public, indent=2), encoding='utf-8')
    return 0 if result.returncode == 0 and status.get('ready') else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print('dsh-pet huniu tunnel launcher failed: ' + type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)
