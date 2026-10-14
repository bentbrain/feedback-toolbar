import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

interface Process {
  pid: number;
  parent: number;
  group: number;
  state: string;
  started: string;
}
async function processTable() {
  const { stdout } = await promisify(execFile)(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return stdout.split('\n').flatMap((line): Process[] => {
    if (!line.trim()) return [];
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!row?.[1] || !row[2] || !row[3] || !row[4] || !row[5])
      throw new Error('Cannot parse the runner process table. Termination cannot be verified.');
    return [
      {
        pid: Number(row[1]),
        parent: Number(row[2]),
        group: Number(row[3]),
        state: row[4],
        started: row[5],
      },
    ];
  });
}
function signal(pid: number, value: NodeJS.Signals) {
  try {
    process.kill(pid, value);
  } catch (error) {
    // macOS can report EPERM for a process that exited between ps and kill.
    // The bounded liveness check below still fails closed for any surviving process.
    if (!(
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'EPERM')
    ))
      throw error;
  }
}

/** The child must start detached, in its own POSIX process group. */
export function superviseRunner(child: ChildProcess) {
  const root = child.pid;
  const known = new Map<number, string>();
  let ended = false;
  let groupGone = false;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) => {
      ended = true;
      reject(error);
    });
    child.once('exit', (code) => {
      ended = true;
      resolve(code);
    });
  });
  // Some startup failures precede the caller reaching its await.
  void exited.catch(() => {
    /* The caller still receives the rejected promise. */
  });
  const capture = async () => {
    if (!root) return [];
    const table = await processTable();
    if (ended && !table.some((row) => row.group === root)) groupGone = true;
    const owned = new Set(
      table
        .filter((row) => (!groupGone && row.group === root) || known.get(row.pid) === row.started)
        .map((row) => row.pid),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table) {
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
      }
    }
    const descendants = table.filter((row) => owned.has(row.pid) && row.pid !== process.pid);
    for (const row of descendants) known.set(row.pid, row.started);
    return descendants.filter((row) => !row.state.startsWith('Z'));
  };
  let sampling: Promise<Process[]> | null = null;
  const sample = () => {
    sampling ??= capture().finally(() => {
      sampling = null;
    });
    return sampling;
  };
  // Remember descendants even if a launcher exits and the OS reparents them.
  const monitor = setInterval(() => {
    void sample().catch(() => {
      /* Termination retries and fails closed. */
    });
  }, 100);
  monitor.unref();
  void sample().catch(() => {
    /* Termination retries and fails closed. */
  });
  let termination: Promise<void> | null = null;
  const terminate = () => {
    termination ??= (async () => {
      clearInterval(monitor);
      let remaining = await sample();
      const send = (rows: Process[], value: NodeJS.Signals) => {
        const leaders = new Set(rows.map((row) => row.pid));
        for (const group of new Set(rows.map((row) => row.group))) {
          if (group === root || leaders.has(group)) signal(-group, value);
        }
        for (const row of rows) signal(row.pid, value);
      };
      // Freeze launchers before signaling so they cannot keep spawning during teardown.
      send(remaining, 'SIGSTOP');
      remaining = await sample();
      send(remaining, 'SIGSTOP');
      send(remaining, 'SIGTERM');
      send(remaining, 'SIGCONT');
      const deadline = Date.now() + 3000;
      const escalation = Date.now() + 1000;
      while ((remaining = await sample()).length) {
        send(remaining, Date.now() >= escalation ? 'SIGKILL' : 'SIGTERM');
        if (Date.now() >= deadline)
          throw new Error(
            'Runner subprocesses are still alive. The worker lock is retained; inspect the processes before retrying.',
          );
        await delay(25);
      }
    })();
    return termination;
  };
  return { exited, terminate };
}
