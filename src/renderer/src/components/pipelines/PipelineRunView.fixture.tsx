import { defineFixture } from '../../component-fixtures/component-fixture'
import { PipelineRunView } from './PipelineRunView'
import { definition, fixtureSummary, status, visits, workspace } from './pipeline-run.fixture-data'

function setup(hardened = false) {
  const readStatus = structuredClone(status)
  const usage = {
    durationMs: 42000,
    tokens: {
      uncachedInput: 1200,
      cacheReadInput: 8000,
      cacheWriteInput: 0,
      output: 900,
      reasoningOutputSubset: 300
    },
    usd: null,
    source: 'journal_turn'
  }
  if (hardened) {
    readStatus.run.state = 'reconciliation_required'
    readStatus.run.reason = 'pipeline_response_quota'
    delete readStatus.run.pendingDecision
    delete readStatus.run.candidate
    readStatus.findingLedger = {
      total: 3,
      omitted: 0,
      unresolvedImportant: 1,
      findings: (['open', 'fixed_verified', 'disputed'] as const).map((disposition, index) => ({
        id: `finding:${String(index + 1).repeat(64)}`,
        candidateId: 'candidate-current',
        severity: 'important',
        detail: [
          'Повтор запроса может применить скидку дважды.',
          'Тест истечения lease теперь проходит на текущих исходниках.',
          'Reviewer предложил новый формат API за пределами требований.'
        ][index],
        conditionToFix: 'Сохранить требования и подтвердить текущими проверками.',
        disposition,
        proposedFixed: false,
        ownerAcknowledged: index === 2,
        ...(index === 2
          ? {
              rationale: 'Совместимость текущего API обязательна.',
              requirement: 'Сохранить существующий API корзины.'
            }
          : {})
      }))
    }
    if (readStatus.run.currentInvocation) {
      readStatus.run.currentInvocation.responseObservation = {
        requestMessageId: 'task-current',
        clientMessageId: 'task-current',
        turnItemId: 'turn-current',
        category: 'quota',
        rawResponse: 'Provider usage limit reached.',
        rawTruncated: false,
        usage: { ...usage, source: 'journal_turn' }
      }
    }
  }
  window.api.runtime.subscribe = async () => ({ unsubscribe: () => {}, sendBinary: () => {} })
  window.api.runtime.call = async ({ method, params }) => {
    const artifactId =
      params &&
      typeof params === 'object' &&
      'artifactId' in params &&
      typeof params.artifactId === 'string'
        ? params.artifactId
        : undefined
    const result =
      method === 'pipeline.v2.status'
        ? readStatus
        : method === 'pipeline.v2.template.show'
          ? { contractVersion: 2, record: { definition } }
          : method === 'pipeline.v2.events'
            ? { events: [], cursor: 13, hasMore: false, latestSequence: 13 }
            : method === 'pipeline.v2.context'
              ? artifactId
                ? {
                    contractVersion: 2,
                    artifacts: [
                      {
                        id: artifactId,
                        summary: fixtureSummary,
                        result: {
                          status: 'result',
                          outcomeId: 'done',
                          evidence: {
                            stage: 'generic',
                            statement: 'Совместимость API сохранена.',
                            rationale: 'Изменение ограничено расчётом скидки.',
                            files: []
                          }
                        }
                      }
                    ]
                  }
                : {
                    contractVersion: 2,
                    runId: 'fixture-run',
                    revision: 12,
                    visits: hardened
                      ? visits.map((visit) => ({
                          ...visit,
                          usage: {
                            durationMs: usage.durationMs,
                            tokens: usage.tokens,
                            usd: null,
                            invocationCount: 1,
                            measuredInvocations: 1
                          }
                        }))
                      : visits,
                    cursor: 2,
                    hasMore: false
                  }
              : undefined
    if (!result) {
      throw new Error(`Unexpected fixture RPC ${method}`)
    }
    return { id: 'fixture', ok: true, _meta: { runtimeId: 'fixture-runtime' }, result }
  }
}
function View({ narrow = false }: { narrow?: boolean }) {
  return (
    <div
      className="overflow-y-auto scrollbar-sleek bg-background text-foreground"
      style={{ height: narrow ? 844 : 1100 }}
    >
      <PipelineRunView workspace={workspace} />
    </div>
  )
}
export const desktop = defineFixture({ width: 1440, setup, render: () => <View /> })
export const narrow = defineFixture({ width: 390, setup, render: () => <View narrow /> })
export const diagnostics = defineFixture({
  width: 1000,
  setup: () => setup(true),
  render: () => (
    <div className="bg-background text-foreground" style={{ height: 2400 }}>
      <PipelineRunView workspace={workspace} />
    </div>
  )
})
