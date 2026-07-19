export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required: boolean;
}

export interface SchemaTemplate {
  id: string;
  label: string;
  title: string;
  fields: SchemaField[];
}

export const TEMPLATES: SchemaTemplate[] = [
  {
    id: 'simple',
    label: 'Simple response',
    title: 'SimpleResponse',
    fields: [{ name: 'response', type: 'string', description: 'The response text', required: true }],
  },
  {
    id: 'structured',
    label: 'Structured data',
    title: 'StructuredData',
    fields: [
      { name: 'name', type: 'string', description: "Person's name", required: true },
      { name: 'age', type: 'number', description: "Person's age", required: false },
      { name: 'email', type: 'string', description: "Person's email address", required: false },
    ],
  },
  {
    id: 'list',
    label: 'List response',
    title: 'ListResponse',
    fields: [{ name: 'items', type: 'array', description: 'List of extracted items', required: true }],
  },
  {
    id: 'classification',
    label: 'Classification',
    title: 'Classification',
    fields: [
      { name: 'category', type: 'string', description: 'The predicted category', required: true },
      { name: 'confidence', type: 'number', description: 'Confidence between 0 and 1', required: false },
      { name: 'reasoning', type: 'string', description: 'Why this category was chosen', required: false },
    ],
  },
  {
    id: 'entities',
    label: 'Entity extraction',
    title: 'EntityExtraction',
    fields: [
      { name: 'entities', type: 'array', description: 'Entities found in the document', required: true },
      { name: 'entity_types', type: 'array', description: 'The type of each entity, in the same order', required: false },
    ],
  },
];

const ARRAY_ITEMS = { type: 'string' };

export function fieldsToSchema(title: string, fields: SchemaField[]): string {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.name.trim()) continue;
    properties[field.name] = {
      type: field.type,
      ...(field.type === 'array' ? { items: ARRAY_ITEMS } : {}),
      ...(field.description ? { description: field.description } : {}),
    };
  }
  const required = fields.filter((f) => f.required && f.name.trim()).map((f) => f.name);

  return JSON.stringify({ type: 'object', title, properties, ...(required.length ? { required } : {}) }, null, 2);
}

/** Reads a hand-edited schema back into visual-builder fields. Returns null if it can't. */
export function schemaToFields(json: string): { title: string; fields: SchemaField[] } | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.properties !== 'object') return null;

    const required: string[] = Array.isArray(parsed.required) ? parsed.required : [];
    const fields: SchemaField[] = Object.entries(parsed.properties as Record<string, any>).map(
      ([name, spec]) => ({
        name,
        type: (['string', 'number', 'boolean', 'array', 'object'] as const).includes(spec?.type)
          ? spec.type
          : 'string',
        description: typeof spec?.description === 'string' ? spec.description : '',
        required: required.includes(name),
      }),
    );
    return { title: typeof parsed.title === 'string' ? parsed.title : 'Schema', fields };
  } catch {
    return null;
  }
}

export function templateToSchema(template: SchemaTemplate): string {
  return fieldsToSchema(template.title, template.fields);
}
