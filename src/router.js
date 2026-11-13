export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile an Express-style path: `/api/products/:id`, `/api/orders/*`, `/files/*.json`.
 * `*` as a whole segment matches the rest of the path (captured as params["*"]).
 */
export function compilePath(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
    throw new Error(`route path must start with "/": ${pattern}`);
  }
  const names = [];
  const segments = pattern.split('/').filter(Boolean);
  let re = '^';
  for (const seg of segments) {
    if (seg === '*' || seg === '**') {
      re += '(?:/(.*))?';
      names.push('*');
    } else if (seg.startsWith(':')) {
      const optional = seg.endsWith('?');
      const name = seg.slice(1, optional ? -1 : undefined);
      re += optional ? '(?:/([^/]+))?' : '/([^/]+)';
      names.push(name);
    } else {
      re += '/' + escapeRe(seg).replace(/\*/g, '[^/]*');
    }
  }
  re += segments.length ? '/?$' : '/$';
  return { regex: new RegExp(re), names };
}

/** Merge route rules with defaults and precompile matchers. */
export function compileRoutes(list = [], defaults = {}) {
  return list.map((r, i) => {
    const writes = Array.isArray(r.invalidates) && r.invalidates.length > 0;
    const methods = (r.methods ?? (writes && r.ttl === undefined ? WRITE_METHODS : defaults.methods ?? ['GET', 'HEAD']))
      .map((m) => String(m).toUpperCase());
    if (methods.includes('GET') && !methods.includes('HEAD')) methods.push('HEAD');
    const { regex, names } = compilePath(r.path);
    return {
      ...defaults,
      ...r,
      name: r.name ?? `route${i + 1}`,
      methods,
      regex,
      names,
      explicitTtl: r.ttl !== undefined,
      tags: r.tags ?? [],
      invalidates: r.invalidates ?? [],
      varyBy: (r.varyBy ?? defaults.varyBy ?? []).map((v) => String(v).toLowerCase()),
    };
  });
}

/** First route whose method list and path match wins. */
export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (!route.methods.includes(method)) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.names.forEach((name, idx) => {
      const v = m[idx + 1];
      if (v === undefined) return;
      try { params[name] = decodeURIComponent(v); } catch { params[name] = v; }
    });
    return { route, params };
  }
  return null;
}

/** "product:{id}" + {id: 5} -> "product:5" */
export function expandTemplate(tpl, params = {}) {
  return String(tpl).replace(/\{([\w*]+)\}/g, (_, k) => params[k] ?? '');
}
