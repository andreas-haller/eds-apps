import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargetHash, shellUrl } from '../host.js';

test('parses the audit target from a DA-style fragment', () => {
  assert.deepEqual(parseTargetHash('#/acme/website'), { org: 'acme', repo: 'website' });
  assert.deepEqual(parseTargetHash('/acme/website/'), { org: 'acme', repo: 'website' });
  assert.deepEqual(parseTargetHash('#/acme/website/en/page'), { org: 'acme', repo: 'website' });
});

test('rejects fragments without a valid org and site', () => {
  ['', '#', '#/acme', '#/acme/<script>', '#/../x', null, undefined].forEach((hash) => {
    assert.equal(parseTargetHash(hash), null, String(hash));
  });
});

test('rebuilds the DA shell URL with a new fragment', () => {
  const context = { org: 'andreas-haller', repo: 'eds-apps', path: 'tools/page-status/page-status', search: '?ref=local' };
  assert.equal(
    shellUrl('https://da.live', context, '#/acme/website'),
    'https://da.live/app/andreas-haller/eds-apps/tools/page-status/page-status?ref=local#/acme/website',
  );
  assert.equal(
    shellUrl('https://stage.da.live', { ...context, search: '' }, '#/acme/website'),
    'https://stage.da.live/app/andreas-haller/eds-apps/tools/page-status/page-status#/acme/website',
  );
});

test('refuses to navigate untrusted or incomplete hosts', () => {
  const context = { org: 'a', repo: 'b', path: 'tools/x' };
  assert.equal(shellUrl('https://evil.example', context, '#/x/y'), null);
  assert.equal(shellUrl('https://da.live.evil.example', context, '#/x/y'), null);
  assert.equal(shellUrl('', context, '#/x/y'), null);
  assert.equal(shellUrl('https://da.live', { org: 'a', repo: 'b' }, '#/x/y'), null);
});
