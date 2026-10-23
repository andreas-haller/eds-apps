import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext, putBriefInChat } from '../host.js';

test('EW context uses the exact organization, repository and document path', () => {
  const context = normalizeContext({ org: 'northstar', repo: 'website', path: '/collections/fall.html' });
  assert.equal(context.siteId, 'northstar/website');
  assert.equal(context.path, '/collections/fall.html');
  assert.equal(context.url, 'https://da.live/canvas#/northstar/website/collections/fall');
  assert.equal(context.title, 'Fall');
});

test('missing host context is not replaced with a guessed page', () => {
  assert.equal(normalizeContext({}), null);
  assert.equal(normalizeContext({ org: 'northstar', repo: 'website' }).url, '');
});

test('chat uses setPrompt without auto-sending or inserting text into the page', () => {
  const calls = [];
  putBriefInChat({
    showPanel: (name) => calls.push(name),
    setPrompt: (text, options) => calls.push({ text, options }),
    sendText: () => assert.fail('Must not insert into the editor'),
  }, 'A project brief');
  assert.deepEqual(calls, [{ text: 'A project brief', options: { autoSend: false } }, 'chat']);
  assert.throws(() => putBriefInChat({}, 'A brief'), /unavailable/);
});
