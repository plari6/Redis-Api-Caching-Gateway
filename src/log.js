const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Tiny leveled logger. Text by default, JSON lines when LOG_FORMAT=json.
 * @param {string} [level]
 * @param {{ json?: boolean, stream?: NodeJS.WritableStream }} [opts]
 */
export function createLogger(level = process.env.LOG_LEVEL || 'info', opts = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const json = opts.json ?? process.env.LOG_FORMAT === 'json';
  const stream = opts.stream ?? process.stderr;
  const write = (lvl, msg, data) => {
    if (LEVELS[lvl] < min) return;
    if (json) {
      stream.write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...data }) + '\n');
      return;
    }
    const extra = data && Object.keys(data).length
      ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
      : '';
    stream.write(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}\n`);
  };
  return {
    level,
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

export const silentLogger = createLogger('silent');
