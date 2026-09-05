#!/usr/bin/env python3
"""Fetch NOAA ETOPO1 nodes at 3 arc minutes; validate and pack south-first Int16LE."""
import csv
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.csv?altitude%5B(24):3:(46)%5D%5B(122):3:(150)%5D'
INFO = 'https://coastwatch.pfeg.noaa.gov/erddap/info/etopo180/index.csv'
WIDTH, HEIGHT, WEST, SOUTH, STEP = 561, 441, 122, 24, .05


def main():
    raw = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '180', '--retry', '2', URL])
    rows = list(csv.reader(io.StringIO(raw.decode())))
    if rows[:2] != [['latitude', 'longitude', 'altitude'], ['degrees_north', 'degrees_east', 'm']]:
        raise ValueError('Unexpected CSV columns or units')
    rows = rows[2:]
    if len(rows) != WIDTH * HEIGHT:
        raise ValueError('Unexpected sample count')
    values = []
    for index, row in enumerate(rows):
        lat, lon, altitude = map(float, row)
        y, x = divmod(index, WIDTH)
        if abs(lat - (SOUTH + y * STEP)) > 1e-7 or abs(lon - (WEST + x * STEP)) > 1e-7:
            raise ValueError(f'Coordinate or ordering mismatch at {index}')
        if altitude != int(altitude) or not -12000 <= altitude <= 9000:
            raise ValueError(f'Invalid/missing altitude at {index}')
        values.append(int(altitude))
    raw_info = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '60', '--retry', '2', INFO])
    attributes = list(csv.DictReader(io.StringIO(raw_info.decode())))
    license_text = next(a['Value'] for a in attributes if a['Attribute Name'] == 'license')
    payload = struct.pack(f'<{len(values)}h', *values)
    metadata = dict(version=1, width=WIDTH, height=HEIGHT, west=WEST, south=SOUTH, step=STEP,
                    order='south-to-north,row-major', registration='cell-center', encoding='int16-le',
                    units='m', horizontalDatum='WGS84', verticalDatum='Mean Sea Level',
                    minElevation=min(values), maxElevation=max(values), byteLength=len(payload),
                    sha256=hashlib.sha256(payload).hexdigest(), file='etopo1-japan-3min.bin',
                    dataset='NOAA NGDC ETOPO1 Ice Surface grid/node registered', sourceUrl=URL,
                    metadataUrl=INFO, retrievedAt=datetime.now(timezone.utc).isoformat(),
                    operation='Every third source node, no averaging or interpolation', license=license_text)
    out = ROOT / 'public' / 'simulation'
    out.mkdir(parents=True, exist_ok=True)
    (out / metadata['file']).write_bytes(payload)
    (out / 'terrain.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: metadata[k] for k in ['width', 'height', 'byteLength', 'sha256', 'minElevation', 'maxElevation']}))


if __name__ == '__main__':
    main()
