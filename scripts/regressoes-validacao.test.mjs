import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hashContrato, verificarAprovacao } from '../server/lib/plano.mjs';
import { extrairResumo, validarEspecificacao } from '../server/lib/servico-calculo.mjs';

function exemploAuditavel() {
  return JSON.parse(readFileSync(new URL('../exemplos/calculo-auditavel.json', import.meta.url), 'utf8'));
}

test('alterar a quantidade de horas extras exige nova aprovação para calcular', () => {
  const spec = exemploAuditavel();
  spec.contrato.aprovacao = { ...spec.contrato.aprovacao, hashContrato: hashContrato(spec) };
  assert.equal(validarEspecificacao(spec).prontoParaCalcular, true);

  spec.verbas.find(({ verba }) => verba === 'HORAS EXTRAS 50%').quantidade = 2000;
  const resultado = validarEspecificacao(spec);
  assert.equal(resultado.valido, true);
  assert.equal(resultado.auditoria.aprovacao.valida, false);
  assert.equal(resultado.prontoParaCalcular, false);

  spec.contrato.aprovacao.hashContrato = hashContrato(spec);
  assert.equal(validarEspecificacao(spec).prontoParaCalcular, true);
});

test('uma aprovação anterior que cobria apenas contrato e cenário exige renovação', () => {
  const spec = exemploAuditavel();
  spec.contrato.aprovacao.hashContrato = '481ffe7ae268514e826498f95d293776bfaadc95722f6268d901d91a174f22c2';
  assert.equal(verificarAprovacao(spec).valida, false);
});

test('reordenar campos e registrar revisão de alerta preserva a aprovação', () => {
  const spec = exemploAuditavel();
  spec.contrato.aprovacao = { ...spec.contrato.aprovacao, hashContrato: hashContrato(spec) };
  spec.contrato.revisoesDeAlerta = [{ item: 'exemplo de alerta', motivo: 'Revisado.' }];
  spec.contrato.aprovacao.observacoes = 'Registro da aprovação complementado.';
  const reordenado = Object.fromEntries(Object.entries(spec).reverse());
  assert.equal(verificarAprovacao(reordenado).valida, true);
});

test('lê rubricas, valores negativos e totais de relatórios de texto em CRLF', () => {
  const fixture = readFileSync(new URL('./fixtures/resumo-com-rubrica-negativa.txt', import.meta.url), 'utf8');
  const lf = fixture.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  const resumo = extrairResumo(crlf);
  assert.equal(resumo.verbas.length, 12);
  assert.equal(resumo.brutoDevidoAoReclamante, 934.22);
  assert.equal(resumo.liquidoDevidoAoReclamante, -7269.06);
  assert.equal(resumo.conferencia.somaConfere, true);
  assert.deepEqual(resumo, extrairResumo(lf));
});
