'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import { useRouter } from '@/i18n/navigation'
import { useCan } from '@/hooks/use-can'
import { createClient } from '@/lib/supabase/client'
import { browserTimeZone } from '@/lib/dashboard/overview'
import {
  allocateAgentCost,
  burstSavings,
  loadCostOverview,
  monthKey,
  parseMonthParam,
  shiftMonth,
  summarizeCost,
  type CostOverview,
} from '@/lib/billing/overview'
import { Button } from '@/components/ui/button'
import {
  BreakdownCard,
  CostKpis,
  DailyCostCard,
  InvoiceCard,
  TeamCostCard,
} from '@/components/costs/cost-cards'

/** Re-pull Meta's analytics when the snapshot is older than this. */
const STALE_MS = 6 * 3_600_000

export default function CostsPage() {
  return (
    <Suspense fallback={null}>
      <CostsPageInner />
    </Suspense>
  )
}

function CostsPageInner() {
  const t = useTranslations('Costs')
  const format = useFormatter()
  const router = useRouter()
  const searchParams = useSearchParams()
  const canView = useCan('edit-settings')
  const month = parseMonthParam(searchParams.get('month'), new Date())
  const currentMonth = monthKey(new Date())

  const [data, setData] = useState<CostOverview | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const requestRef = useRef(0)
  const autoSyncedRef = useRef(false)

  const load = useCallback(async (target: string) => {
    const request = ++requestRef.current
    try {
      const next = await loadCostOverview(createClient(), target, browserTimeZone())
      if (request !== requestRef.current) return null
      setData(next)
      setFailed(null)
      return next
    } catch (err) {
      if (request !== requestRef.current) return null
      console.error('[costs] overview failed:', err)
      setFailed(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  const sync = useCallback(async () => {
    setSyncing(true)
    setSyncError(null)
    try {
      const res = await fetch('/api/billing/sync', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? t('syncFailed'))
      }
      await load(month)
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : t('syncFailed'))
    } finally {
      setSyncing(false)
    }
  }, [load, month, t])

  useEffect(() => {
    if (!canView) return
    setData(null)
    void load(month).then((loaded) => {
      // Meta's numbers only reach the page through a sync; pull them once
      // per visit when this or last month's snapshot is missing or stale.
      if (!loaded || autoSyncedRef.current) return
      const recent = month >= shiftMonth(currentMonth, -1)
      const fetchedAt = loaded.meta.fetchedAt ? Date.parse(loaded.meta.fetchedAt) : 0
      if (recent && Date.now() - fetchedAt > STALE_MS) {
        autoSyncedRef.current = true
        void sync()
      }
    })
  }, [canView, load, month, currentMonth, sync])

  const summary = useMemo(() => (data ? summarizeCost(data) : null), [data])
  const agents = useMemo(
    () => (data && summary ? allocateAgentCost(data, summary) : []),
    [data, summary],
  )
  const savings = data && summary ? burstSavings(data, summary) : null

  const goTo = (target: string) => {
    router.replace(`/dashboard/costs?month=${target.slice(0, 7)}`, { scroll: false })
  }

  if (!canView) {
    return (
      <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
        {t('adminOnly')}
      </div>
    )
  }

  const monthLabel = format.dateTime(new Date(`${month}T12:00:00`), {
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{t('title')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t('previousMonth')}
              onClick={() => goTo(shiftMonth(month, -1))}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <span className="min-w-32 text-center text-sm font-medium capitalize">{monthLabel}</span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t('nextMonth')}
              disabled={month >= currentMonth}
              onClick={() => goTo(shiftMonth(month, 1))}
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw className={syncing ? 'animate-spin' : undefined} aria-hidden />
            {syncing ? t('syncing') : t('sync')}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {data?.meta.fetchedAt
          ? t('lastSynced', {
              when: format.relativeTime(new Date(data.meta.fetchedAt)),
            })
          : t('neverSynced')}
        {syncError ? <span className="ml-2 text-destructive">{syncError}</span> : null}
      </p>

      {failed && !data ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
          <p className="text-xs text-muted-foreground">{failed}</p>
          <Button variant="outline" size="sm" onClick={() => void load(month)}>
            {t('retry')}
          </Button>
        </div>
      ) : (
        <>
          <CostKpis data={data} summary={summary} savings={savings} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <DailyCostCard data={data} />
            <InvoiceCard data={data} onSaved={() => void load(month)} />
          </div>
          <TeamCostCard data={data} rows={agents} />
          <BreakdownCard data={data} />
        </>
      )}
    </div>
  )
}
