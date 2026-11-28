'use client'

import { useState } from 'react'
import { Receipt } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import { BarChart } from '@/components/tremor/bar-chart'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'
import type {
  AgentCostRow,
  CostOverview,
  CostSummary,
} from '@/lib/billing/overview'

function useMoney(currency: string | null) {
  const format = useFormatter()
  return (value: number, digits = 2) =>
    format.number(value, {
      style: 'currency',
      currency: currency ?? 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
}) {
  return (
    <Card className="gap-1 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  )
}

export function CostKpis({
  data,
  summary,
  savings,
}: {
  data: CostOverview | null
  summary: CostSummary | null
  savings: number | null
}) {
  const t = useTranslations('Costs.kpi')
  const format = useFormatter()
  const money = useMoney(data?.meta.currency ?? null)

  if (!data || !summary) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] w-full rounded-xl" />
        ))}
      </div>
    )
  }

  const burstShare =
    data.outbound.total > 0 ? data.outbound.bursts / data.outbound.total : 0

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile
        label={t('metaCost')}
        value={money(data.meta.cost)}
        hint={
          summary.projectedCost != null
            ? t('projected', { amount: money(summary.projectedCost, 0) })
            : t('noData')
        }
      />
      <Tile
        label={t('paidReplies')}
        value={format.number(summary.serviceBillable)}
        hint={
          summary.serviceRate != null
            ? t('paidRepliesHint', {
                rate: money(summary.serviceRate, 3),
                free: format.number(summary.serviceFree),
              })
            : t('noData')
        }
      />
      <Tile
        label={t('templates')}
        value={money(summary.templateCost)}
        hint={t('templatesHint')}
      />
      <Tile
        label={t('bursts')}
        value={format.number(burstShare, {
          style: 'percent',
          maximumFractionDigits: 0,
        })}
        hint={
          savings != null
            ? t('burstsHint', {
                count: format.number(data.outbound.bursts),
                amount: money(savings, 0),
              })
            : t('burstsHintNoRate', {
                count: format.number(data.outbound.bursts),
              })
        }
      />
    </div>
  )
}

export function DailyCostCard({ data }: { data: CostOverview | null }) {
  const t = useTranslations('Costs.daily')
  const format = useFormatter()
  const money = useMoney(data?.meta.currency ?? null)
  const costLabel = t('cost')

  const chart = (data?.daily ?? []).map((d) => ({
    label: format.dateTime(new Date(`${d.day}T12:00:00`), {
      day: 'numeric',
      month: 'short',
    }),
    [costLabel]: Math.round(d.metaCost * 100) / 100,
  }))
  const hasData = (data?.daily ?? []).some((d) => d.metaCost > 0)

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {!data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Receipt}
            title={t('empty')}
            hint={t('emptyHint')}
            className="flex-1"
          />
        ) : (
          <BarChart
            className="min-h-[240px] flex-1"
            data={chart}
            index="label"
            categories={[costLabel]}
            colors={['violet']}
            yAxisWidth={44}
            showLegend={false}
            valueFormatter={(v) => money(v)}
          />
        )}
      </CardContent>
    </Card>
  )
}

export function BreakdownCard({ data }: { data: CostOverview | null }) {
  const t = useTranslations('Costs.breakdown')
  const format = useFormatter()
  const money = useMoney(data?.meta.currency ?? null)
  const rows = data?.meta.breakdown ?? []

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-[200px] w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('category')}</TableHead>
                <TableHead>{t('country')}</TableHead>
                <TableHead className="text-right">{t('messages')}</TableHead>
                <TableHead className="text-right">{t('cost')}</TableHead>
                <TableHead className="text-right">{t('rate')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.category}-${r.type}-${r.country}`}>
                  <TableCell>
                    <span className="font-medium">
                      {t(`categories.${categoryKey(r.category)}`)}
                    </span>
                    {r.type !== 'REGULAR' ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {t(`types.${typeKey(r.type)}`)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>{r.country}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {format.number(r.volume)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(r.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.volume > 0 && r.cost > 0 ? money(r.cost / r.volume, 3) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

const CATEGORY_KEYS = ['SERVICE', 'MARKETING', 'UTILITY', 'AUTHENTICATION'] as const
const TYPE_KEYS = ['FREE_CUSTOMER_SERVICE', 'FREE_ENTRY_POINT'] as const

function categoryKey(category: string): string {
  return (CATEGORY_KEYS as readonly string[]).includes(category)
    ? category.toLowerCase()
    : 'other'
}

function typeKey(type: string): string {
  return (TYPE_KEYS as readonly string[]).includes(type)
    ? type.toLowerCase()
    : 'other'
}

export function TeamCostCard({
  data,
  rows,
}: {
  data: CostOverview | null
  rows: AgentCostRow[]
}) {
  const t = useTranslations('Costs.team')
  const format = useFormatter()
  const money = useMoney(data?.meta.currency ?? null)
  const pct = (v: number) =>
    format.number(v, { style: 'percent', maximumFractionDigits: 0 })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-[160px] w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('agent')}</TableHead>
                <TableHead className="text-right">{t('sent')}</TableHead>
                <TableHead className="text-right">{t('chats')}</TableHead>
                <TableHead className="text-right">{t('perChat')}</TableHead>
                <TableHead className="text-right">{t('bursts')}</TableHead>
                <TableHead className="text-right">{t('repeats')}</TableHead>
                <TableHead className="text-right">{t('voiceNotes')}</TableHead>
                <TableHead className="text-right">{t('estCost')}</TableHead>
                <TableHead className="text-right">{t('dealsWon')}</TableHead>
                <TableHead className="text-right">{t('perDeal')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.userId}>
                  <TableCell className="font-medium">
                    {r.name || t('unnamed')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {format.number(r.outbound)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {format.number(r.conversations)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {format.number(r.outboundPerConversation, {
                      maximumFractionDigits: 1,
                    })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(r.burstShare)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {format.number(r.repeats)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {format.number(r.voiceNotes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(r.estimatedCost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {format.number(r.dealsWon)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.costPerDealWon != null ? money(r.costPerDealWon) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t('footnote')}</p>
      </CardContent>
    </Card>
  )
}

export function InvoiceCard({
  data,
  onSaved,
}: {
  data: CostOverview | null
  onSaved: () => void
}) {
  const t = useTranslations('Costs.invoice')
  const money = useMoney(data?.invoice?.currency ?? data?.meta.currency ?? null)
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const month = data?.month.slice(0, 7)
  const gap =
    data?.invoice != null ? data.invoice.amount - data.meta.cost : null

  const save = async () => {
    if (!month) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/invoice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month,
          amount: Number(amount.replace(',', '.')),
          currency: data?.meta.currency ?? 'USD',
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? t('saveFailed'))
      }
      setAmount('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.invoice ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">{t('invoiced')}</dt>
            <dd className="text-right font-medium tabular-nums">
              {money(data.invoice.amount)}
            </dd>
            <dt className="text-muted-foreground">{t('metaReported')}</dt>
            <dd className="text-right tabular-nums">{money(data.meta.cost)}</dd>
            <dt className="text-muted-foreground">{t('gap')}</dt>
            <dd className="text-right tabular-nums">
              {gap != null ? money(gap) : '—'}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Input
            inputMode="decimal"
            placeholder={t('placeholder')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={t('placeholder')}
          />
          <Button type="submit" size="sm" disabled={saving || !amount.trim()}>
            {data?.invoice ? t('update') : t('save')}
          </Button>
        </form>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}
