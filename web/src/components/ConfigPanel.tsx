import { SchemaBuilder } from './SchemaBuilder';
import { MODELS, type ConfidenceMode, type OcrConfig, type TableMode } from '../lib/types';

interface Props {
  config: OcrConfig;
  onChange: (patch: Partial<OcrConfig>) => void;
  onClose: () => void;
}

const TABLE_MODES: { id: TableMode; label: string }[] = [
  { id: 'markdown_embedded', label: 'Markdown embedded' },
  { id: 'markdown_standalone', label: 'Markdown standalone' },
  { id: 'html_standalone', label: 'HTML standalone' },
];

const CONFIDENCE_MODES: { id: ConfidenceMode; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'word', label: 'Word' },
  { id: 'page', label: 'Page' },
];

export function ConfigPanel({ config, onChange, onClose }: Props) {
  return (
    <aside className="config" aria-label="Configuration">
      <div className="config-head">
        <h2>Configure</h2>
        <button className="icon" onClick={onClose} aria-label="Close configuration">✕</button>
      </div>

      <div className="config-grid">
        <label className="field">
          <span>Model</span>
          <select value={config.model} onChange={(e) => onChange({ model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Pages</span>
          <input
            value={config.pages}
            placeholder="all — or 1-4,8"
            onChange={(e) => onChange({ pages: e.target.value })}
          />
        </label>

        <div className="field">
          <span>Extract</span>
          <div className="chips">
            <Chip on={config.extractImages} onClick={() => onChange({ extractImages: !config.extractImages })}>
              Images
            </Chip>
            <Chip on={config.extractHeader} onClick={() => onChange({ extractHeader: !config.extractHeader })}>
              Header
            </Chip>
            <Chip on={config.extractFooter} onClick={() => onChange({ extractFooter: !config.extractFooter })}>
              Footer
            </Chip>
          </div>
        </div>

        <label className="field toggle-field">
          <span>Extract bounding boxes</span>
          <Toggle on={config.boundingBoxes} onChange={(on) => onChange({ boundingBoxes: on })} />
        </label>

        <label className="field">
          <span>Extract tables</span>
          <select value={config.tableMode} onChange={(e) => onChange({ tableMode: e.target.value as TableMode })}>
            {TABLE_MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Confidence scores</span>
          <select
            value={config.confidence}
            onChange={(e) => onChange({ confidence: e.target.value as ConfidenceMode })}
          >
            {CONFIDENCE_MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="addons">
        <label className="field toggle-field">
          <span>Annotate images</span>
          <Toggle on={config.annotateImages} onChange={(on) => onChange({ annotateImages: on })} />
        </label>
        {config.annotateImages && (
          <p className="note">
            Each detected image gets an annotation instruction; results appear on the Visual tab.
          </p>
        )}

        <label className="field toggle-field">
          <span>Response format (structured output)</span>
          <Toggle on={config.responseFormat} onChange={(on) => onChange({ responseFormat: on })} />
        </label>

        {config.responseFormat && (
          <SchemaBuilder
            schema={config.jsonSchema}
            annotationPrompt={config.annotationPrompt}
            onSchema={(jsonSchema) => onChange({ jsonSchema })}
            onPrompt={(annotationPrompt) => onChange({ annotationPrompt })}
          />
        )}
      </div>
    </aside>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`chip-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
}
