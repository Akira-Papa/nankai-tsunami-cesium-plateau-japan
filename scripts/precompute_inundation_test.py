import importlib.util,pathlib,tempfile,unittest,zipfile,json
spec=importlib.util.spec_from_file_location('precompute',pathlib.Path(__file__).with_name('precompute_inundation.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class AggregationTest(unittest.TestCase):
 def test_preserves_separate_max_and_earliest(self):
  with tempfile.TemporaryDirectory() as d:
   d=pathlib.Path(d);z=d/'input.zip'
   def row(lon,lat,dep,arr):
    r=[str(lon),str(lat),'0',str(arr)]+['-9999']*9+[str(dep),'0','0'];return ','.join(r)
   with zipfile.ZipFile(z,'w') as f:f.writestr('sample.csv','header\n'+row(136.9,35.1,4,120)+'\n'+row(136.9,35.1,2,60)+'\n'+row(136.9,35.1,3,-9999))
   c=m.convert(z,'1',d/'out');self.assertEqual(c['sourceRows'],3)
   for level in c['levels']:
    data=json.loads((d/'out'/level['tiles'][0]['path']).read_text());self.assertEqual(data[0][2:],[4,60,3])
 def test_grid_centers_are_idempotent(self):
  for size in m.LEVELS:
   key,center=m.bucket(136.9,35.1,size);self.assertEqual(m.bucket(*center,size)[0],key)
if __name__=='__main__':unittest.main()
