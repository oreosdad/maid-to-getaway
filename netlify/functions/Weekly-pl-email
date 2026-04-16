// netlify/functions/weekly-pl-email.js
// Runs every Friday, emails a P&L summary to the admin
// Schedule: set in netlify.toml

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const ADMIN_EMAIL          = process.env.ADMIN_EMAIL || 'cutcojohngilmore@gmail.com';

exports.handler = async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase env vars');
    return { statusCode: 500 };
  }
  if (!RESEND_API_KEY) {
    console.error('Missing RESEND_API_KEY — add it in Netlify env vars');
    return { statusCode: 500 };
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Date range: Mon–Sun of the week that just ended
  const now = new Date();
  const dayOfWeek = now.getDay(); // 5 = Friday
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) - 7);
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23,59,59,999);

  const start = monday.toISOString().split('T')[0];
  const end   = sunday.toISOString().split('T')[0];

  // Also get MTD for context
  const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const today    = now.toISOString().split('T')[0];

  const fmt = cents => '$' + (cents/100).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

  // Fetch jobs for the week
  const { data: weekJobs } = await db.from('jobs')
    .select('charge_cents, additional_cleaning_cents, additional_cleaning_collected, payout_cents, status, properties(name), job_assignments(payout_cents, profiles(full_name, is_owner_operator))')
    .eq('status', 'completed')
    .is('deleted_at', null)
    .gte('scheduled_date', start)
    .lte('scheduled_date', end);

  // Fetch MTD jobs
  const { data: mtdJobs } = await db.from('jobs')
    .select('charge_cents, additional_cleaning_cents, additional_cleaning_collected, job_assignments(payout_cents, profiles(is_owner_operator))')
    .eq('status', 'completed')
    .is('deleted_at', null)
    .gte('scheduled_date', mtdStart)
    .lte('scheduled_date', today);

  // Fetch expenses for the week
  const { data: weekExp } = await db.from('expenses')
    .select('amount_cents, category')
    .gte('date', start)
    .lte('date', end);

  const calcMetrics = (jobs, expenses) => {
    const revenue = (jobs||[]).reduce((s,j) => {
      return s + (j.charge_cents||0) + (j.additional_cleaning_collected ? (j.additional_cleaning_cents||0) : 0);
    }, 0);
    const allPayouts = (jobs||[]).reduce((s,j) => {
      const a = j.job_assignments||[];
      return s + (a.length ? a.reduce((ps,x)=>ps+(x.payout_cents||0),0) : (j.payout_cents||0));
    }, 0);
    const contractorPay = (jobs||[]).reduce((s,j) => {
      const a = j.job_assignments||[];
      if (!a.length) return s + (j.payout_cents||0);
      if (a.every(x=>x.profiles?.is_owner_operator)) return s;
      return s + a.filter(x=>!x.profiles?.is_owner_operator).reduce((ps,x)=>ps+(x.payout_cents||0),0);
    }, 0);
    const otherExp = (expenses||[]).reduce((s,e)=>s+e.amount_cents,0);
    const totalExp = allPayouts + otherExp;
    const profit = revenue - totalExp;
    return { revenue, contractorPay, allPayouts, otherExp, totalExp, profit, jobCount: (jobs||[]).length };
  };

  const week = calcMetrics(weekJobs, weekExp);
  const mtd  = calcMetrics(mtdJobs, []);

  // Build job list for the week
  const jobRows = (weekJobs||[]).map(j => {
    const cleaners = (j.job_assignments||[]).map(a=>a.profiles?.full_name).filter(Boolean).join(', ') || '—';
    const charge = fmt(j.charge_cents||0);
    const payout = fmt((j.job_assignments||[]).reduce((s,a)=>s+(a.payout_cents||0),0));
    return `<tr style="border-bottom:1px solid #EDE6D6">
      <td style="padding:8px 12px">${j.properties?.name||'—'}</td>
      <td style="padding:8px 12px;font-size:13px;color:#7A7060">${cleaners}</td>
      <td style="padding:8px 12px;text-align:right">${charge}</td>
      <td style="padding:8px 12px;text-align:right;color:#C0392B">${payout}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;color:${week.profit>=0?'#1E7B4B':'#C0392B'}">${fmt((j.charge_cents||0)-(j.job_assignments||[]).reduce((s,a)=>s+(a.payout_cents||0),0))}</td>
    </tr>`;
  }).join('');

  const weekLabel = `${monday.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${sunday.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;

  const html = `
  <!DOCTYPE html>
  <html>
  <body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#F4EFE4;padding:24px;color:#1C2B3A">
    <div style="max-width:600px;margin:0 auto">
      <div style="background:#0F4A45;border-radius:12px 12px 0 0;padding:24px 28px">
        <h1 style="margin:0;font-size:20px;color:white">Maid to Getaway</h1>
        <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.6)">Weekly P&L — ${weekLabel}</p>
      </div>
      <div style="background:white;padding:28px;border-radius:0 0 12px 12px">

        <!-- Week summary -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px">
          <div style="background:#F4EFE4;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060;margin-bottom:4px">Revenue</div>
            <div style="font-size:22px;font-weight:600;color:#0F4A45">${fmt(week.revenue)}</div>
          </div>
          <div style="background:#F4EFE4;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060;margin-bottom:4px">Expenses</div>
            <div style="font-size:22px;font-weight:600;color:#C0392B">${fmt(week.totalExp)}</div>
          </div>
          <div style="background:${week.profit>=0?'#EAF7F0':'#FDEEEE'};border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060;margin-bottom:4px">Profit</div>
            <div style="font-size:22px;font-weight:600;color:${week.profit>=0?'#1E7B4B':'#C0392B'}">${fmt(week.profit)}</div>
          </div>
        </div>

        <!-- Jobs this week -->
        <h3 style="font-size:14px;font-weight:600;color:#0F4A45;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.06em">${week.jobCount} Jobs This Week</h3>
        ${week.jobCount > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
          <thead>
            <tr style="background:#F4EFE4">
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060">Property</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060">Cleaner</th>
              <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060">Charge</th>
              <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060">Payout</th>
              <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060">Profit</th>
            </tr>
          </thead>
          <tbody>${jobRows}</tbody>
        </table>` : '<p style="color:#7A7060;font-size:13px;margin-bottom:24px">No completed jobs this week.</p>'}

        <!-- MTD context -->
        <div style="background:#F4EFE4;border-radius:8px;padding:16px;margin-bottom:24px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#7A7060;margin-bottom:10px">Month to Date</div>
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
            <span>Revenue</span><strong>${fmt(mtd.revenue)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
            <span>Contractor pay</span><strong style="color:#C0392B">${fmt(mtd.contractorPay)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px;border-top:1px solid #EDE6D6;padding-top:8px;margin-top:8px">
            <span style="font-weight:600">Profit</span><strong style="color:${mtd.profit>=0?'#1E7B4B':'#C0392B'}">${fmt(mtd.profit)}</strong>
          </div>
        </div>

        <p style="font-size:12px;color:#7A7060;text-align:center;margin:0">
          Maid to Getaway · <a href="https://maidtogetaway.com/admin.html" style="color:#0F4A45">Open Admin</a>
        </p>
      </div>
    </div>
  </body>
  </html>`;

  // Send via Resend
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: 'Maid to Getaway <reports@maidtogetaway.com>',
      to: [ADMIN_EMAIL],
      subject: `Weekly P&L — ${weekLabel}`,
      html
    })
  });

  const emailData = await emailRes.json();
  if (!emailRes.ok) {
    console.error('Email send failed:', emailData);
    return { statusCode: 500, body: JSON.stringify({ error: emailData }) };
  }

  console.log('Weekly P&L sent:', emailData.id);
  return { statusCode: 200, body: JSON.stringify({ success: true, emailId: emailData.id }) };
};
