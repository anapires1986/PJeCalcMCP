import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { D, txt } from '../server/lib/decimal.mjs';
import { gerarCalculo } from '../server/lib/gerador.mjs';
import { aplicarEdicoes, conferirEdicoes } from '../server/lib/ocorrencias.mjs';
import { campo, dataMs, definir, itens, msParaData, xmlParaArvore } from '../server/lib/pjc.mjs';
import { recalcularPjc } from '../server/lib/recalculo.mjs';

test('recálculo aplica um índice em notação científica menor que um milionésimo', () => {
  const arvore = xmlParaArvore(`<Calculo><verbas><Set><Calculada><id>1</id><nome>FICTÍCIA</nome>
    <ativo>true</ativo><ocorrencias><Set><OcorrenciaDeVerba><ativo>true</ativo>
    <devido>1000000</devido><pago>0</pago><indiceAcumulado>1.23456789E-7</indiceAcumulado>
    <dataInicial>${dataMs('2024-01-01')}</dataInicial></OcorrenciaDeVerba></Set></ocorrencias>
    </Calculada></Set></verbas></Calculo>`);

  assert.equal(txt(recalcularPjc(arvore).verbas[0].corrigido), '0.12');
});

test('conversão científica mantém a mantissa exata com expoentes positivos e negativos', () => {
  const casos = [
    ['1.234E-2', 5, '0.01234'],
    [1.23456789e-7, 15, '0.000000123456789'],
    ['-.125E+2', 2, '-12.50'],
    ['+12.e3', 2, '12000.00'],
    ['9007199254740993E-2', 2, '90071992547409.93'],
    ['0E-25', 2, '0.00'],
  ];
  for (const [entrada, casas, esperado] of casos) {
    assert.equal(txt(D(entrada), casas), esperado, String(entrada));
  }
});

test('expoentes extremos respeitam a escala sem expandir a mantissa sem limite', () => {
  assert.equal(D('1e-34'), 1n);
  assert.equal(D('-1e-35'), 0n);
  assert.equal(D('1e-1000000000000'), 0n);
  assert.equal(D('0e+1000000000000'), 0n);
  assert.throws(() => D('1e+1000000000000'), RangeError);
});

test('geração recusa admissão em dia inexistente no calendário', () => {
  const spec = JSON.parse(readFileSync(new URL('../exemplos/calculo-referencia.json', import.meta.url), 'utf8'));
  spec.calculo.admissao = '2013-02-31';

  assert.throws(() => gerarCalculo(spec), /calculo\.admissao: data inválida/i);
});

test('geração recusa mês inexistente em ocorrência do histórico salarial', () => {
  const spec = JSON.parse(readFileSync(new URL('../exemplos/calculo-referencia.json', import.meta.url), 'utf8'));
  spec.historicosSalariais[0].ocorrencias = [{ competencia: '2013-13', valor: 9999 }];

  assert.throws(() => gerarCalculo(spec), /historicosSalariais\[0\]\.ocorrencias\[0\]\.competencia: competência inválida/i);
});

test('conversão de datas recusa dias e meses fora do calendário em ambos os formatos', () => {
  for (const invalida of ['2023-02-29', '31/04/2024', '2024-00-01', '01/00/2024', '2024-00', '00/2024', '2024-13', '13/2024']) {
    assert.throws(() => dataMs(invalida), /data inválida/i, invalida);
  }
});

test('conversão de datas mantém ano menor que 100 e aceita competências e milissegundos válidos', () => {
  const casos = [
    ['0099-02-01', '0099-02-01'],
    ['01/02/0099', '0099-02-01'],
    [new Date('0099-02-01T13:45:00Z'), '0099-02-01'],
    ['29/02/2024', '2024-02-29'],
    ['2024-02', '2024-02-01'],
    ['02/2024', '2024-02-01'],
  ];
  for (const [entrada, esperado] of casos) assert.equal(msParaData(dataMs(entrada)), esperado, String(entrada));
  assert.equal(dataMs('1704078000000'), '1704078000000');
  assert.equal(dataMs(null), null);
});

test('conferência reconhece valores em formato brasileiro e acusa divergência de valor', () => {
  const arvore = xmlParaArvore(`<Calculo><verbas><Set><Calculada><id>1</id><nome>FICTÍCIA</nome>
    <ocorrencias><Set><OcorrenciaDeVerba><dataInicial>${dataMs('2024-01-01')}</dataInicial>
    <pago>0</pago></OcorrenciaDeVerba></Set></ocorrencias></Calculada></Set></verbas></Calculo>`);
  const edicoes = [{ verba: 'FICTÍCIA', itens: [{ competencia: '2024-01', pago: '1.500,00', multiplicador: '1,234567891' }] }];
  aplicarEdicoes(arvore, edicoes);
  const [verba] = itens(campo(arvore, 'verbas'));
  const [ocorrencia] = itens(campo(verba, 'ocorrencias'));

  assert.equal(campo(ocorrencia, 'pago'), '1500.0000000000000000000000000');
  assert.equal(campo(ocorrencia, 'multiplicador'), '1.23456789');
  assert.equal(conferirEdicoes(arvore, edicoes).estado, 'ok');

  definir(ocorrencia, 'pago', '1499.99');
  const divergencia = conferirEdicoes(arvore, edicoes);
  assert.equal(divergencia.estado, 'falha');
  assert.match(divergencia.detalhe, /pago 1499\.99/);
});
