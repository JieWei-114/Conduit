import { useState } from 'react';

/** Collapsible JSON viewer. Click a row to copy its path (e.g. data.items[0].id). */
export default function JsonTree({ data }: { data: unknown }) {
  return (
    <div className="jtree">
      <Node k={null} v={data} path="" depth={0} />
    </div>
  );
}

function Node({ k, v, path, depth }: { k: string | null; v: unknown; path: string; depth: number }) {
  const isObj = v !== null && typeof v === 'object';
  const isArr = Array.isArray(v);
  const [open, setOpen] = useState(depth < 2); // auto-expand first couple levels
  const keyLabel = k === null ? '' : `${k}: `;

  const copyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (path) navigator.clipboard.writeText(path);
  };

  if (!isObj) {
    return (
      <div className="jrow" onClick={copyPath} title={path ? `copy path: ${path}` : ''}>
        <span className="jkey">{keyLabel}</span>
        <span className={`jval jv-${v === null ? 'null' : typeof v}`}>
          {typeof v === 'string' ? `"${v}"` : String(v)}
        </span>
      </div>
    );
  }

  const entries = isArr
    ? (v as unknown[]).map((val, i) => [String(i), val] as [string, unknown])
    : Object.entries(v as Record<string, unknown>);
  const brace = isArr ? ['[', ']'] : ['{', '}'];

  return (
    <div>
      <div className="jrow" onClick={() => setOpen((o) => !o)}>
        <span className="jtoggle">{open ? '▾' : '▸'}</span>
        <span className="jkey">{keyLabel}</span>
        <span className="jmeta">
          {brace[0]}
          {open ? '' : `… ${entries.length}`}
          {open ? '' : brace[1]}
          {path && (
            <i className="jcopy" title={`copy path: ${path}`} onClick={copyPath}> ⧉</i>
          )}
        </span>
      </div>
      {open && (
        <div className="jchildren">
          {entries.map(([ck, cv]) => (
            <Node
              key={ck}
              k={ck}
              v={cv}
              path={path ? (isArr ? `${path}[${ck}]` : `${path}.${ck}`) : isArr ? `[${ck}]` : ck}
              depth={depth + 1}
            />
          ))}
          <div className="jrow jbrace">{brace[1]}</div>
        </div>
      )}
    </div>
  );
}
