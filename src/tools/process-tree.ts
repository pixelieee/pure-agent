import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Node reaps its direct child. POSIX descendants in the owned process group are terminated.
 * A deliberately detached daemon can escape a process group: this is NOT a sandbox/subreaper.
 * Windows uses taskkill /T /F, not POSIX signal semantics; integration must be tested on Windows.
 */
export async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    const command = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(command, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timeout = setTimeout(() => killer.kill(), 5_000);
      killer.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      killer.once('close', (code) => {
        clearTimeout(timeout);
        // taskkill reports nonzero if the process already exited. An alive leader is not success.
        if (code !== 0 && child.exitCode === null && child.signalCode === null)
          reject(new Error(`taskkill failed (${code})`));
        else resolve();
      });
    });
    return;
  }
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!send('SIGTERM')) return;
  // Do not cancel escalation merely because the leader exits; children may ignore TERM.
  await delay(graceMs);
  send('SIGKILL');
  // Signal delivery is asynchronous. Do not publish a settled result while the group still exists.
  // Non-reaping container init processes can retain zombie grandchildren; report rather than hide it.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(10);
  }
  throw new Error('Process group still exists after SIGKILL; descendant cleanup could not be confirmed');
}
