import { useState } from 'react';
import {
  TEMPLATES,
  fieldsToSchema,
  schemaToFields,
  templateToSchema,
  type SchemaField,
} from '../lib/templates';

interface Props {
  schema: string;
  annotationPrompt: string;
  onSchema: (json: string) => void;
  onPrompt: (text: string) => void;
}

const TYPES: SchemaField['type'][] = ['string', 'number', 'boolean', 'array', 'object'];

export function SchemaBuilder({ schema, annotationPrompt, onSchema, onPrompt }: Props) {
  const [mode, setMode] = useState<'visual' | 'code'>('visual');

  const parsed = schemaToFields(schema);
  const title = parsed?.title ?? 'Schema';
  const fields = parsed?.fields ?? [];
  const invalid = schema.trim() !== '' && parsed === null;

  const write = (nextTitle: string, nextFields: SchemaField[]) =>
    onSchema(fieldsToSchema(nextTitle, nextFields));

  const patchField = (index: number, patch: Partial<SchemaField>) =>
    write(title, fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  return (
    <div className="schema-builder">
      <div className="row">
        <div className="segmented">
          <button className={mode === 'visual' ? 'on' : ''} onClick={() => setMode('visual')}>Visual</button>
          <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>Code</button>
        </div>

        <label className="field">
          <span>Templates</span>
          <select
            value=""
            onChange={(e) => {
              const template = TEMPLATES.find((t) => t.id === e.target.value);
              if (template) onSchema(templateToSchema(template));
            }}
          >
            <option value="">Choose a template…</option>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>
      </div>

      {invalid && <p className="error">The schema is not valid JSON. The visual builder is paused until it parses.</p>}

      {mode === 'visual' ? (
        <div className="visual-builder">
          <label className="field">
            <span>Schema title</span>
            <input value={title} onChange={(e) => write(e.target.value, fields)} />
          </label>

          {fields.map((field, i) => (
            <div className="field-row" key={i}>
              <input
                aria-label="Field name"
                placeholder="name"
                value={field.name}
                onChange={(e) => patchField(i, { name: e.target.value })}
              />
              <select
                aria-label="Field type"
                value={field.type}
                onChange={(e) => patchField(i, { type: e.target.value as SchemaField['type'] })}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input
                aria-label="Field description"
                placeholder="description"
                value={field.description}
                onChange={(e) => patchField(i, { description: e.target.value })}
              />
              <label className="req" title="Required">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(e) => patchField(i, { required: e.target.checked })}
                />
                req
              </label>
              <button
                className="btn tiny"
                aria-label={`Remove ${field.name || 'field'}`}
                onClick={() => write(title, fields.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}

          <button
            className="btn tiny"
            onClick={() =>
              write(title, [...fields, { name: '', type: 'string', description: '', required: false }])
            }
          >
            ＋ Add field
          </button>
        </div>
      ) : (
        <textarea
          className="code-editor"
          spellCheck={false}
          rows={12}
          value={schema}
          placeholder="{ }"
          onChange={(e) => onSchema(e.target.value)}
        />
      )}

      <label className="field">
        <span>Annotation prompt (optional)</span>
        <textarea
          rows={2}
          value={annotationPrompt}
          placeholder="Extract the invoice total and the supplier name."
          onChange={(e) => onPrompt(e.target.value)}
        />
      </label>
    </div>
  );
}
