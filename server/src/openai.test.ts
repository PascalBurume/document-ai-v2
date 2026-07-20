import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIVisionBody, openAIResponseText, openaiVisionModelName } from './openai.js';

test('OpenAI response text supports the Responses API output shape', () => {
  assert.equal(openAIResponseText({
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
  }), '{"ok":true}');
});

test('OpenAI response text tolerates SDK-style output_text fixtures', () => {
  assert.equal(openAIResponseText({ output_text: 'ready' }), 'ready');
});

test('OpenAI vision body uses Responses API multimodal inputs at original detail without storage', () => {
  const body = buildOpenAIVisionBody('system', 'inspect', ['data:image/png;base64,AAAA'], 900);
  assert.equal(body.instructions, 'system');
  assert.equal(body.max_output_tokens, 900);
  assert.equal(body.store, false);
  assert.deepEqual(body.input[0].content, [
    { type: 'input_text', text: 'inspect' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'original' },
  ]);
});

test('OpenAI vision model is configurable without changing code', () => {
  const before = process.env.OPENAI_VISION_MODEL;
  try {
    process.env.OPENAI_VISION_MODEL = 'gpt-test-vision';
    assert.equal(openaiVisionModelName(), 'gpt-test-vision');
  } finally {
    if (before === undefined) delete process.env.OPENAI_VISION_MODEL;
    else process.env.OPENAI_VISION_MODEL = before;
  }
});
