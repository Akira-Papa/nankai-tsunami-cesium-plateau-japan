import { describe, expect, it } from 'vitest';
import { readShare, shareSearch, type ShareState } from './explorerState';

describe('共有URLの境界と再現性', () => {
  const cases = ['case01', 'case02'];
  it('パラメータなしでは収録先頭ケースを選び視点は指定しない', () => {
    const result = readShare('', cases);
    expect(result.state.caseId).toBe('case01');
    expect(result.state.mode).toBe('max');
    expect(result.camera).toBeUndefined();
  });
  it('未知のケースや表示モードを採用しない', () => {
    expect(readShare('?case=unavailable&mode=wave', cases).state).toMatchObject({caseId:'case01',mode:'max'});
    expect(readShare('?case=case02&mode=arrival', cases).state).toMatchObject({caseId:'case02',mode:'arrival'});
    expect(readShare('?case=case02', []).state.caseId).toBe('');
  });
  it('0分・透明度0を欠損値にしない', () => {
    expect(readShare('?min=0&opacity=0', cases).state).toMatchObject({minutes:0,opacity:0});
  });
  it('UIで操作できる範囲に値を制限する', () => {
    expect(readShare('?min=9999&opacity=2', cases).state).toMatchObject({minutes:720,opacity:1});
    expect(readShare('?min=-5&opacity=-1', cases).state).toMatchObject({minutes:0,opacity:0});
  });
  it.each(['NaN', 'Infinity', '-Infinity', '', 'abc'])('不正な数値 %s は既定値になる', value => {
    const state = readShare(`?min=${value}&opacity=${value}`, cases).state;
    expect(state.minutes).toBeGreaterThanOrEqual(0); expect(state.minutes).toBeLessThanOrEqual(720);
    expect(state.opacity).toBe(.75);
  });
  it.each(['?lon=NaN&lat=35', '?lon=135&lat=Infinity', '?lon=&lat=35', '?lat=35', '?lon=135'])('不正・欠けた座標 %s を使わない', search => {
    expect(readShare(search, cases).camera).toBeUndefined();
  });
  it('視点を有限の安全な範囲へ制限する', () => {
    expect(readShare('?lon=999&lat=-999&height=-1&heading=999&pitch=40', cases).camera).toEqual({lon:180,lat:-85,height:100,heading:360,pitch:-5});
  });
  it('表示スイッチを明示的な値から復元する', () => {
    expect(readShare('?buildings=0&photo=1&lite=1', cases).state).toMatchObject({buildings:false,photo:true,lite:true});
    expect(readShare('?buildings=false&photo=true&lite=unknown', cases).state).toMatchObject({buildings:true,photo:false,lite:false});
  });
  it('共有すると同じケース・条件と丸めた視点を再現できる', () => {
    const state: ShareState = {caseId:'case02',mode:'arrival',minutes:0,opacity:0,buildings:false,photo:true,lite:true};
    const camera = {lon:133.53123,lat:33.55972,height:14000,heading:12.34,pitch:-55};
    expect(readShare(shareSearch(state,camera), cases)).toEqual({state,camera});
  });
});
