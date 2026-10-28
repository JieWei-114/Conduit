import { describe, expect, it } from 'vitest';
import { appendQuery, joinUrl } from './url';

describe('joinUrl', () => {
  it('joins with exactly one slash however the parts are written', () => {
    expect(joinUrl('http://h:8080/', '/pkg.Svc/', '/Method')).toBe('http://h:8080/pkg.Svc/Method');
    expect(joinUrl('http://h//', '//a//')).toBe('http://h/a');
    expect(joinUrl('http://h', 'a')).toBe('http://h/a');
  });

  it('keeps the base when there is nothing to add', () => {
    expect(joinUrl('http://h/api/', '', '  ', '/')).toBe('http://h/api');
    expect(joinUrl('  http://h  ')).toBe('http://h');
  });

  it('leaves slashes inside a part alone', () => {
    expect(joinUrl('http://h', 'v1/users')).toBe('http://h/v1/users');
  });
});

describe('appendQuery', () => {
  it('starts or continues the query', () => {
    expect(appendQuery('http://h/p', 'a=1')).toBe('http://h/p?a=1');
    expect(appendQuery('http://h/p?x=0', 'a=1')).toBe('http://h/p?x=0&a=1');
  });

  it('adds no separator after a trailing ? or &', () => {
    expect(appendQuery('http://h/p?', 'a=1')).toBe('http://h/p?a=1');
    expect(appendQuery('http://h/p?x=0&', 'a=1')).toBe('http://h/p?x=0&a=1');
  });

  it('puts the query before the fragment', () => {
    expect(appendQuery('http://h/p#top', 'a=1')).toBe('http://h/p?a=1#top');
    expect(appendQuery('http://h/p?x=0#top', 'a=1')).toBe('http://h/p?x=0&a=1#top');
  });

  it('a ? inside the fragment is not a query', () => {
    expect(appendQuery('http://h/p#a?b', 'a=1')).toBe('http://h/p?a=1#a?b');
  });

  it('returns the URL untouched for an empty query', () => {
    expect(appendQuery('http://h/p#x', '')).toBe('http://h/p#x');
  });
});
