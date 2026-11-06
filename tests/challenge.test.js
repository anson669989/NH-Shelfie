import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isChallengePage } from '../src/services/parse.js'

const json = readFileSync(new URL('./fixtures/gallery-api-v1.json', import.meta.url), 'utf8')
const cfHtml =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></head><body></body></html>'

describe('isChallengePage', () => {
  it('503 的 "Just a moment..." challenge 頁', () => {
    expect(isChallengePage({ status: 503, contentType: 'text/html; charset=UTF-8', body: cfHtml })).toBe(true)
  })
  it('403 + HTML 即使沒有特徵字串也算被擋', () => {
    expect(isChallengePage({ status: 403, contentType: 'text/html', body: '<html><body>Forbidden</body></html>' })).toBe(true)
  })
  it('content-type 缺失但內文是 HTML 的 403', () => {
    expect(isChallengePage({ status: 403, contentType: '', body: '<!doctype html><p>no</p>' })).toBe(true)
  })
  it('內文含 cf-chl / challenge-platform / cf_chl_opt 特徵', () => {
    for (const body of ['<div id="cf-chl-widget"></div>', 'window._cf_chl_opt={}', '/cdn-cgi/challenge-platform/x']) {
      expect(isChallengePage({ status: 200, contentType: 'text/html', body })).toBe(true)
    }
  })
  it('Cloudflare "Attention Required" 攔截頁', () => {
    expect(isChallengePage({ status: 403, body: '<title>Attention Required! | Cloudflare</title>' })).toBe(true)
  })
  it('正常 JSON 不是 challenge', () => {
    expect(isChallengePage({ status: 200, contentType: 'application/json', body: json })).toBe(false)
  })
  it('200 的一般 HTML 不是 challenge', () => {
    expect(isChallengePage({ status: 200, contentType: 'text/html', body: '<!doctype html><title>nhentai</title>' })).toBe(false)
  })
  it('404 JSON 不是 challenge', () => {
    expect(isChallengePage({ status: 404, contentType: 'application/json', body: '{"error":"does not exist"}' })).toBe(false)
  })
  it('空輸入不丟錯', () => {
    expect(isChallengePage()).toBe(false)
    expect(isChallengePage({ status: 503 })).toBe(false)
  })
})
