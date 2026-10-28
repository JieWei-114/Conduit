import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  fmtBytes,
  isSensitiveHeader,
  MASK,
  maskDeep,
  maskHeaderLines,
  maskHeaders,
  maskHeaderValue,
  maskQuery,
  maskUrl,
  shellQuote,
} from './share';

const HOSTILE = [
  '',
  'plain',
  "it's",
  'a b\tc',
  '$(id) `id` $HOME ${x} !! * ? ~ ; | & > <',
  'line1\nline2',
  'cr\rlf\r\n',
  'back\\slash \\n literal',
  "mixed ' and \n and \\",
  '\x00x\x01\x1b[31m\x7f',
  '{"json": "value with \'quotes\'"}',
];

describe('shellQuote', () => {
  for (const shell of ['bash', 'zsh']) {
    it(`${shell} reads back exactly what was quoted`, () => {
      for (const s of HOSTILE) {
        if (s.includes('\x00')) continue;
        const out = execFileSync(shell, ['-c', `printf %s ${shellQuote(s)}`], { encoding: 'utf8' });
        expect(out).toBe(s);
      }
    });
  }

  it('never lets a newline end a continued command', () => {
    for (const s of HOSTILE) expect(shellQuote(s)).not.toMatch(/[\n\r]/);
  });
});

describe('isSensitiveHeader', () => {
  it('flags credential names', () => {
    for (const n of ['Authorization', 'x-api-key', 'Cookie', 'Set-Cookie', 'X-Auth-Token', 'client_secret', 'password', 'x-signature', 'sig', 'x-sig'])
      expect(isSensitiveHeader(n), n).toBe(true);
  });

  it('leaves ordinary names alone', () => {
    for (const n of ['content-type', 'accept', 'user-agent', 'x-request-id', 'signal', 'design'])
      expect(isSensitiveHeader(n), n).toBe(false);
  });
});

describe('maskQuery', () => {
  it('blanks credential values and keeps the rest as written', () => {
    expect(maskQuery('a=1&token=abc&b=%20x')).toBe(`a=1&token=${MASK}&b=%20x`);
  });

  it('judges an encoded key by its decoded name', () => {
    expect(maskQuery('api%5Fkey=abc')).toBe(`api%5Fkey=${MASK}`);
    expect(maskQuery('access+token=abc')).toBe(`access+token=${MASK}`);
  });

  it('survives a malformed escape and a key without a value', () => {
    expect(maskQuery('%E0%A4%A=1&token')).toBe('%E0%A4%A=1&token');
  });
});

describe('maskUrl', () => {
  it('blanks the userinfo password and keeps the user', () => {
    expect(maskUrl('postgres://me:s3cret@db:5432/app')).toBe(`postgres://me:${MASK}@db:5432/app`);
  });

  it('blanks all of a password that itself holds an @', () => {
    const out = maskUrl('https://me:p@ss@host/path');
    expect(out).toBe(`https://me:${MASK}@host/path`);
    expect(out).not.toContain('ss@');
  });

  it('leaves a user without a password alone', () => {
    expect(maskUrl('ssh://git@host/repo')).toBe('ssh://git@host/repo');
  });

  it('does not take an @ in the path or query for userinfo', () => {
    expect(maskUrl('https://host/users/a:b@c')).toBe('https://host/users/a:b@c');
    expect(maskUrl('https://host/p?mail=a:b@c')).toBe('https://host/p?mail=a:b@c');
  });

  it('blanks credential query values but not the fragment', () => {
    expect(maskUrl('https://h/p?api_key=abc&x=1#token=keep')).toBe(`https://h/p?api_key=${MASK}&x=1#token=keep`);
  });
});

describe('header masking', () => {
  it('blanks credential lines and keeps the rest', () => {
    expect(maskHeaderLines('Authorization: Bearer abc\naccept: */*\nbad line')).toBe(`Authorization: ${MASK}\naccept: */*\nbad line`);
  });

  it('keeps the auth scheme word so the shape stays readable', () => {
    expect(maskHeaderValue('Authorization', 'Bearer abc.def')).toBe(`Bearer ${MASK}`);
    expect(maskHeaderValue('Authorization', 'Basic dXNlcjpw')).toBe(`Basic ${MASK}`);
    expect(maskHeaderValue('x-api-key', 'abc')).toBe(MASK);
    expect(maskHeaderValue('accept', 'text/plain')).toBe('text/plain');
  });

  it('masks a header map by name', () => {
    expect(maskHeaders({ cookie: 'sid=1', accept: 'x' })).toEqual({ cookie: MASK, accept: 'x' });
  });
});

describe('maskDeep', () => {
  it('masks secret values inside the data, keeping the JSON valid', () => {
    const out = maskDeep({ a: 'x hunter22 y', n: [{ b: 'hunter22' }], ok: true }, ['hunter22']) as any;
    expect(JSON.stringify(out)).not.toContain('hunter22');
    expect(out.ok).toBe(true);
    expect(out.a.startsWith('x ')).toBe(true);
  });

  it('blanks credential-named string fields only when asked', () => {
    expect(maskDeep({ token: 'abc', count: 3 }, [], true)).toEqual({ token: MASK, count: 3 });
    expect(maskDeep({ token: 'abc' }, [])).toEqual({ token: 'abc' });
  });
});

describe('fmtBytes', () => {
  it('picks the unit', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1023)).toBe('1023 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(3 * 1048576)).toBe('3.0 MB');
  });
});
