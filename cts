#!/bin/python

import base64
import hashlib
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from xml.etree import ElementTree as ET

config = {
  'ddts': { 'username': '', 'password': '' },
  'ctws': { 'username': '', 'password': '' },
  'holding': ''
}

def animals():
  xmlns = {
    'request': 'http://defra.bcms.ctws/holding_request',
    'results': 'http://defra.bcms.ctws/holding_request_results'
  }

  request = ET.Element('GetHolding', xmlns = xmlns['request'],
    SchemaVersion = '1.0', ProgramName = 'cts-tool', ProgramVersion = '1.0',
    RequestTimeStamp = datetime.utcnow().isoformat() + '+00:00')
  ET.SubElement(ET.SubElement(request, 'Authentication'), 'CTS_OL_User',
    Usr = config['ctws']['username'], Pwd = config['ctws']['password'])

  holding = ET.SubElement(request, 'Holding', Loc = config['holding'])
  if config.get('site'):
    holding.attrib['SLoc'] = config['site']

  results, animals = transfer('Get_Cattle_On_Holding-V1-0', request), []
  for animal in results.findall('.//results:Animal', xmlns):
    animals.append((animal.attrib.get('Etg', '').replace(' ', '') or '?',
                    animal.attrib.get('Brd', '').upper() or '?',
                    animal.attrib.get('Sex', '').upper() or '?',
                    animal.attrib.get('Dob') or '?',
                    animal.attrib.get('OnDate') or '?'))

  animals.sort(key = lambda a: a[0][-5:])
  animals.sort(key = lambda a: a[3])
  animals.sort(key = lambda a: a[4])
  for animal in animals:
    print(' '.join(animal))

def legal(date):
  try:
    return re.fullmatch(r'\d{4}-\d{2}-\d{2}', date) \
      and datetime.strptime(date, "%Y-%m-%d") < datetime.now()
  except:
    return False

def queries():
  xmlns = {
    'request': 'http://defra.bcms.ctws/holding_request',
    'results': 'http://defra.bcms.ctws/holding_request_results'
  }

  request = ET.Element('GetHolding', xmlns = xmlns['request'],
    SchemaVersion = '1.0', ProgramName = 'cts-tool', ProgramVersion = '1.0',
    RequestTimeStamp = datetime.utcnow().isoformat() + '+00:00')
  ET.SubElement(ET.SubElement(request, 'Authentication'), 'CTS_OL_User',
    Usr = config['ctws']['username'], Pwd = config['ctws']['password'])

  holding = ET.SubElement(request, 'Holding', Loc = config['holding'])
  if config.get('site'):
    holding.attrib['SLoc'] = config['site']

  results = transfer('Get_Cattle_On_Holding-V1-0', request)

  for animal in results.findall('.//results:QueriedAnimal', xmlns):
    print('animal', animal.attrib.get('Etg', '').replace(' ', '') or '?',
      animal.attrib.get('Brd', '').upper() or '?',
      animal.attrib.get('Sex', '').upper() or '?',
      animal.attrib.get('Dob') or '?',
      animal.attrib.get('OnDate') or '?')

  for move in results.findall('.//results:QueriedMovement', xmlns):
    kind = move.attrib.get('MovType') or '?'
    kind = { '2': 'on', '3': 'off', '7': 'death' }.get(kind, kind)
    print('move', move.attrib.get('Etg', '').replace(' ', '') or '?',
      kind, move.attrib.get('MovDate') or '?')

def move(kind, date, tags):
  xmlns = {
    'submit': 'http://defra.bcms.ctws/register_movements_request',
    'receipt': 'http://defra.bcms.ctws/asynchronous_receipt',
    'request': 'http://defra.bcms.ctws/get_asynchronous_results',
    'results': 'http://defra.bcms.ctws/register_movements_request_results'
  }

  request = ET.Element('RegMovs', xmlns = xmlns['submit'],
    SchemaVersion = '1.0', ProgramName = 'cts-tool', ProgramVersion = '1.0',
    RequestTimeStamp = datetime.utcnow().isoformat() + '+00:00')
  ET.SubElement(ET.SubElement(request, 'Authentication'), 'CTS_OL_User',
    Usr = config['ctws']['username'], Pwd = config['ctws']['password'])

  moves = ET.SubElement(request, 'Moves', TxnId = str(time.time_ns()))
  attrs = { 'Loc' : config['holding'], 'MType': kind, 'MDate':  date }
  if config.get('site'):
    attrs['SLoc'] = config['site']
  for row, tag in enumerate(tags):
    ET.SubElement(moves, 'Mov', attrs, RowNum = str(row + 1), Etg = tag)

  response = transfer('Register_Movements_Asynchronous-V1-0', request)
  receipt = response.find('.//receipt:Receipt', xmlns).attrib['Num']
  print('Receipt:', receipt)

  request = ET.Element('GetResults', xmlns = xmlns['request'],
    SchemaVersion = '1.0', ProgramName = 'cts-tool', ProgramVersion = '1.0',
    RequestTimeStamp = datetime.utcnow().isoformat() + '+00:00')
  ET.SubElement(ET.SubElement(request, 'Authentication'), 'CTS_OL_User',
    Usr = config['ctws']['username'], Pwd = config['ctws']['password'])
  ET.SubElement(request, 'Receipt', Num = str(receipt))

  while True:
    results = transfer('Get_Register_Movements_Validation_Results-V1-0',
      request)
    error = results.find('.//results:SystemException', xmlns)
    if error is None or error.attrib.get('ExNum') != 'CTWS806':
      break
    print('Waiting for validation results')

  if error is not None:
    code, message = error.attrib.get('ExNum'), error.attrib.get('ExMsg')
    if code and message:
      sys.stderr.write(f'Error {code}: {message}\n')
    else:
      sys.stderr.write('Error: unknown CTWS exception\n')
    sys.exit(1)

  accepted = results.findall('.//results:Accept', xmlns)
  rejected = results.findall('.//results:Reject', xmlns)

  print('Accepted:', len(accepted))
  print('Rejected:', len(rejected))
  for row in rejected:
    tag = row.find('.//results:Mov', xmlns).attrib['Etg'].replace(' ','')
    for cause in row.findall('.//results:Cause', xmlns):
      print(tag, 'rejected:', cause.attrib['Desc'].lower())

def readtags(file):
  lines = (line.split(None, 1) for line in file)
  return (words[0] for words in lines if words)

def serialise(element):
  element = ET.tostring(element, 'utf-8')
  return b'<?xml version="1.0" encoding="utf-8"?>' + element

def transfer(kind, request):
  url = 'https://webservice.secure.ddts.defra.gov.uk/' \
          + 'DefraDataTransferPublicNWSE.asmx'
  xmlns = {
    'envelope': 'http://schemas.xmlsoap.org/soap/envelope/',
    'defra': 'http://www.defra.gov.uk'
  }

  request = base64.b64encode(serialise(request)).decode('ascii')
  envelope = ET.Element('Envelope', xmlns = xmlns['envelope'])

  transfer = ET.SubElement(ET.SubElement(envelope, 'Body'),
    'TransferDataHex', xmlns = xmlns['defra'])
  ET.SubElement(transfer, 'username').text = config['ddts']['username']
  ET.SubElement(transfer, 'password').text \
    = hashlib.md5(config['ddts']['password'].encode()).hexdigest()
  ET.SubElement(transfer, 'serviceName').text = 'DEFRA-CTWS'
  ET.SubElement(transfer, 'type').text = kind
  ET.SubElement(transfer, 'data').text = request

  try:
    request = urllib.request.Request(url, serialise(envelope), {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'http://www.defra.gov.uk/TransferDataHex'
    })
    text = urllib.request.urlopen(request).read()
  except urllib.error.HTTPError as error:
    sys.stderr.write(f'HTTP error {error.code}\n')
    sys.exit(1)
  except urllib.error.URLError as error:
    sys.stderr.write(f'URL error: {error.reason}\n')
    sys.exit(1)

  try:
    text = ET.XML(text).find('.//defra:TransferDataHexResult', xmlns).text
    text = base64.b64decode(text).decode('utf-8')
    return ET.XML(text)
  except:
    sys.stderr.write(f'Invalid DDTS response: {text}\n')
    sys.exit(1)

if not config['ddts']['username'] or not config['ddts']['password']:
  try:
    config['ddts']['username'], config['ddts']['password'] \
      = os.environ['DDTSAUTH'].split(':', 1)
  except:
    sys.stderr.write('DDTSAUTH should be set to USERNAME:PASSWORD\n')
    sys.exit(1)

if not config['ctws']['username'] or not config['ctws']['password']:
  try:
    config['ctws']['username'], config['ctws']['password'] \
      = os.environ['CTWSAUTH'].split(':', 1)
  except:
    sys.stderr.write('CTWSAUTH should be set to USERNAME:PASSWORD\n')
    sys.exit(1)

config['holding'] = config['holding'] or os.environ.get('HOLDING', '')
if match := re.fullmatch(r'(\d+/\d+/\d+)-(\d{2})', config['holding']):
  config['holding'], config['site'] = match.group(1, 2)
elif not re.fullmatch(r'\d+/\d+/\d+', config['holding']):
  sys.stderr.write('HOLDING should be set to CC/PPP/HHHH[-NN]\n')
  sys.exit(1)

if len(sys.argv) == 2 and sys.argv[1] == 'list':
  animals()
elif len(sys.argv) >= 3 and sys.argv[1] == 'death' and legal(sys.argv[2]):
  move(sys.argv[1], sys.argv[2], sys.argv[3:] or readtags(sys.stdin))
elif len(sys.argv) >= 4 and sys.argv[1] == 'move' \
    and sys.argv[2] in ['death', 'off', 'on'] and legal(sys.argv[3]):
  move(sys.argv[2], sys.argv[3], sys.argv[4:] or readtags(sys.stdin))
elif len(sys.argv) == 2 and sys.argv[1] == 'queries':
  queries()
else:
  sys.stderr.write(f'''\
Usage:
  {sys.argv[0]} list
  {sys.argv[0]} death YYYY-MM-DD [TAG]...
  {sys.argv[0]} move off YYYY-MM-DD [TAG]...
  {sys.argv[0]} move on YYYY-MM-DD [TAG]...
  {sys.argv[0]} queries
Tags are read from stdin if not supplied as arguments.
''')
  sys.exit(64)
