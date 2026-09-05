#!/usr/bin/env python3
"""Aggregate Cabinet Office CSV ZIPs. Never publish original ZIP/10m records."""
import argparse,csv,hashlib,io,json,math,pathlib,zipfile
BASE='https://www.geospatial.jp/ckan/dataset/26804359-b035-4df2-84cc-eb2121172a1e'
SOURCES={'1':BASE+'/resource/267c28b4-17f3-43c9-a0e0-8055b186e787/download/01_.zip','4':BASE+'/resource/7ef9e1a8-d754-49e0-8ce4-d76694b52155/download/04_.zip'}
LEVELS=(100,500,2500)
def bucket(lon,lat,size):
    dy=size/111320; iy=math.floor(lat/dy); cy=(iy+.5)*dy
    dx=size/(111320*math.cos(math.radians(cy)));ix=math.floor(lon/dx)
    return (ix,iy),((ix+.5)*dx,cy)
def convert(path,case,out):
    grids={s:{} for s in LEVELS};count=0;files=[]
    with zipfile.ZipFile(path) as z:
      bad=z.testzip()
      if bad:raise ValueError('ZIP CRC failure: '+bad)
      for name in z.namelist():
        if not name.lower().endswith('.csv'):continue
        try:label=name.encode('cp437').decode('cp932')
        except (UnicodeError,LookupError):label=name
        files.append(label); print("CSV",label,flush=True)
        with z.open(name) as f:
          rows=csv.reader(io.TextIOWrapper(f,encoding='cp932'));next(rows)
          for row in rows:
            lon,lat,depth=float(row[0]),float(row[1]),float(row[13]); a=float(row[3]);arrival=a if math.isfinite(a) and a>=0 else None
            if not all(math.isfinite(v) for v in (lon,lat,depth)) or depth<=0:continue
            count+=1
            for size,g in grids.items():
              k,(x,y)=bucket(lon,lat,size)
              if k not in g:g[k]=[round(x,6),round(y,6),depth,arrival,1]
              else:
                v=g[k];v[2]=max(v[2],depth);v[4]+=1
                if arrival is not None:v[3]=arrival if v[3] is None else min(v[3],arrival)
    levels=[]
    for size,g in grids.items():
      assert sum(v[4] for v in g.values()) == count, "Aggregation lost source cells"
      tiles={}
      factor=4 if size==100 else 1
      for v in g.values():tiles.setdefault(f'{math.floor(v[0]*factor)}_{math.floor(v[1]*factor)}',[]).append(v)
      specs=[]
      for key,values in sorted(tiles.items()):
        rel=f'{case}/{size}/{key}.json';p=out/rel;p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(json.dumps(values,separators=(',',':')))
        xs=[v[0] for v in values];ys=[v[1] for v in values]
        specs.append({'path':rel,'bounds':[min(xs),min(ys),max(xs),max(ys)],'count':len(values)})
      levels.append({'resolutionM':size,'tiles':specs,'count':len(g)})
    vals=list(grids[2500].values());bounds=[min(v[0] for v in vals),min(v[1] for v in vals),max(v[0] for v in vals),max(v[1] for v in vals)]
    return {'id':case,'label':f'ケース{int(case):02d}｜越流時に堤防破堤','available':True,'sourceUrl':SOURCES.get(case,BASE),'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'sourceRows':count,'sourceFiles':files,'bounds':bounds,'levels':levels}
def main():
    p=argparse.ArgumentParser();p.add_argument('--input',action='append',required=True,help='caseId=/absolute/input.zip');p.add_argument('--output',default='public/inundation');a=p.parse_args();out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
    existing=out/'manifest.json'
    cases=json.loads(existing.read_text())['cases'] if existing.exists() else []
    for item in a.input:
      case,path=item.split('=',1);cases=[c for c in cases if c['id']!=case];print('Processing case',case,flush=True);cases.append(convert(pathlib.Path(path),case,out));print('Processed',cases[-1]['sourceRows'],flush=True)
    manifest={'version':1,'source':'内閣府 南海トラフの巨大地震モデル・被害想定手法検討会（2025）を独自集約加工','sourceUrl':BASE,'licenseUrl':BASE+'/resource/414d34d1-6277-4f80-8137-d63dc9212c67/download/license.pdf','originalResolutionM':10,'coordinateSystem':'JGD2000の経緯度を表示に使用。原点座標のセル内位置は説明書に明記なし。','depthDefinition':'集約セル内の参考浸水深（第14列）の最大値。セル全域の深さではない。','arrivalDefinition':'集約セル内の1cm到達時間（第4列）の最早値。負の欠損値を除外。','aggregation':'100/500/2500m相当の緯度帯グリッドへ集約。最大深さと最早到達は別の元セルに由来しうる。セル全体の浸水境界ではない。','cases':cases}
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':main()
