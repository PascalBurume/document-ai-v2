import type { DocFile, OcrConfig } from './types';

/** The request body the server would send, with the document payload shown as a placeholder. */
function bodyFor(config: OcrConfig, doc: DocFile | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    document:
      doc?.sourceType === 'image_url'
        ? { type: 'image_url', image_url: '<data-uri-or-signed-url>' }
        : { type: 'document_url', document_url: '<data-uri-or-signed-url>' },
    include_image_base64: config.extractImages,
    include_blocks: config.boundingBoxes,
  };
  if (config.pages.trim()) body.pages = '<0-based page list from "' + config.pages + '">';
  if (config.confidence !== 'none') body.confidence_scores = config.confidence;
  if (config.annotateImages) body.bbox_annotation_format = { type: 'json_schema', json_schema: { name: 'image_annotation', schema: '<image annotation schema>' } };
  if (config.responseFormat && config.jsonSchema.trim()) {
    body.document_annotation_format = {
      type: 'json_schema',
      json_schema: { name: 'document_annotation', schema: JSON.parse(safeSchema(config.jsonSchema)) },
    };
  }
  return body;
}

function safeSchema(json: string): string {
  try {
    JSON.parse(json);
    return json;
  } catch {
    return '{}';
  }
}

export function toCurl(config: OcrConfig, doc: DocFile | null): string {
  return `curl https://api.mistral.ai/v1/ocr \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $MISTRAL_API_KEY" \\
  -d '${JSON.stringify(bodyFor(config, doc), null, 2)}'`;
}

export function toPython(config: OcrConfig, doc: DocFile | null): string {
  const body = bodyFor(config, doc);
  const name = doc?.name ?? 'document.pdf';
  return `import base64, os
from mistralai import Mistral

client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

with open("${name}", "rb") as f:
    encoded = base64.b64encode(f.read()).decode()

response = client.ocr.process(
    model=${JSON.stringify(config.model)},
    document={
        "type": ${JSON.stringify(doc?.sourceType ?? 'document_url')},
        ${doc?.sourceType === 'image_url' ? '"image_url"' : '"document_url"'}: f"data:${doc?.mime ?? 'application/pdf'};base64,{encoded}",
    },
    include_image_base64=${config.extractImages ? 'True' : 'False'},
${extraPy(body)})

print(response.pages[0].markdown)`;
}

function extraPy(body: Record<string, unknown>): string {
  const lines: string[] = [];
  if ('include_blocks' in body) lines.push(`    include_blocks=${body.include_blocks ? 'True' : 'False'},`);
  if ('pages' in body) lines.push(`    pages=[0],  # 0-based, from your page range`);
  if ('confidence_scores' in body) lines.push(`    confidence_scores=${JSON.stringify(body.confidence_scores)},`);
  if ('bbox_annotation_format' in body) lines.push(`    bbox_annotation_format={"type": "json_schema", "json_schema": {...}},`);
  if ('document_annotation_format' in body) lines.push(`    document_annotation_format={"type": "json_schema", "json_schema": {...}},`);
  return lines.join('\n');
}

export function toTypeScript(config: OcrConfig, doc: DocFile | null): string {
  const body = bodyFor(config, doc);
  const name = doc?.name ?? 'document.pdf';
  return `import { Mistral } from "@mistralai/mistralai";
import { readFileSync } from "node:fs";

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });

const encoded = readFileSync("${name}").toString("base64");

const response = await client.ocr.process(${JSON.stringify(
    {
      ...body,
      document:
        doc?.sourceType === 'image_url'
          ? { type: 'image_url', imageUrl: `data:${doc?.mime};base64,\${encoded}` }
          : { type: 'document_url', documentUrl: `data:${doc?.mime ?? 'application/pdf'};base64,\${encoded}` },
    },
    null,
    2,
  ).replace(/"data:([^"]+)"/, '`data:$1`')});

console.log(response.pages[0].markdown);`;
}
