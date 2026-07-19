import { useState } from 'react';
import { toCurl, toPython, toTypeScript } from '../lib/codegen';
import { copy } from '../lib/download';
import type { DocFile, OcrConfig } from '../lib/types';

type Lang = 'python' | 'typescript' | 'curl';

interface Props {
  config: OcrConfig;
  doc: DocFile | null;
  onClose: () => void;
}

export function CodeModal({ config, doc, onClose }: Props) {
  const [lang, setLang] = useState<Lang>('python');

  const code =
    lang === 'python' ? toPython(config, doc) : lang === 'typescript' ? toTypeScript(config, doc) : toCurl(config, doc);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Export code">
        <div className="modal-head">
          <div className="segmented">
            <button className={lang === 'python' ? 'on' : ''} onClick={() => setLang('python')}>Python</button>
            <button className={lang === 'typescript' ? 'on' : ''} onClick={() => setLang('typescript')}>TypeScript</button>
            <button className={lang === 'curl' ? 'on' : ''} onClick={() => setLang('curl')}>cURL</button>
          </div>
          <span className="spacer" />
          <button className="btn tiny" onClick={() => void copy(code)}>Copy</button>
          <button className="icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <pre className="code">{code}</pre>
        <p className="note">
          This is the request your current configuration produces. The key stays on the server — these
          snippets read it from <code>MISTRAL_API_KEY</code> in your own environment.
        </p>
      </div>
    </div>
  );
}
