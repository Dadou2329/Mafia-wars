// Lien Internet automatique : un « quick tunnel » Cloudflare (gratuit, sans compte) expose le
// serveur local sur une adresse publique https://….trycloudflare.com. L'adversaire n'a plus
// qu'à ouvrir le lien d'invitation, même s'il n'est pas sur le même réseau, sans rien régler
// sur la box. Le programme « cloudflared » est livré à côté de MafiaWars.exe.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type TunnelState = 'off' | 'starting' | 'ready' | 'failed';

export interface TunnelInfo {
  state: TunnelState;
  url: string | null;
}

const info: TunnelInfo = { state: 'off', url: null };
let child: ChildProcess | null = null;

export function tunnelInfo(): TunnelInfo {
  return { ...info };
}

/** Emplacement de cloudflared : variable CLOUDFLARED, sinon à côté de l'exécutable. */
function findCloudflared(): string | null {
  if (process.env.CLOUDFLARED) return existsSync(process.env.CLOUDFLARED) ? process.env.CLOUDFLARED : null;
  const dir = dirname(process.execPath);
  for (const name of process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const READY_RE = /Registered tunnel connection/i;

/**
 * Lance le tunnel vers http://localhost:<port>. `onReady` est appelé quand l'adresse publique
 * répond (connexion au réseau Cloudflare établie), `onFail` si c'est impossible.
 */
export function startTunnel(port: number, onReady: (url: string) => void, onFail: (why: string) => void): void {
  const bin = findCloudflared();
  if (!bin) {
    info.state = 'failed';
    onFail('cloudflared introuvable (il doit se trouver à côté de MafiaWars.exe)');
    return;
  }
  info.state = 'starting';
  let pending: string | null = null;
  let done = false;
  const fail = (why: string): void => {
    if (done) return;
    done = true;
    info.state = 'failed';
    info.url = null;
    onFail(why);
  };
  try {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    fail(String(e));
    return;
  }
  const onData = (buf: Buffer): void => {
    const text = buf.toString();
    pending ??= URL_RE.exec(text)?.[0] ?? null;
    if (!done && pending && READY_RE.test(text)) {
      done = true;
      info.state = 'ready';
      info.url = pending;
      onReady(pending);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (e) => fail(e.message));
  child.on('exit', (code) => {
    child = null;
    if (!done) fail(`cloudflared s’est arrêté (code ${code})`);
    else if (info.state === 'ready') {
      info.state = 'failed';
      info.url = null;
      onFail('le tunnel s’est fermé');
    }
  });
  // sans réponse du réseau Cloudflare au bout d'une minute : on abandonne
  setTimeout(() => {
    if (!done) {
      fail('pas de réponse du réseau Cloudflare');
      stopTunnel();
    }
  }, 60_000).unref();
}

export function stopTunnel(): void {
  try {
    child?.kill();
  } catch {
    /* déjà arrêté */
  }
  child = null;
}

process.on('exit', stopTunnel);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    stopTunnel();
    process.exit(0);
  });
}
