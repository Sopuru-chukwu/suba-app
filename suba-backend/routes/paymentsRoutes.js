// suba-backend/routes/paymentsRoutes.js
import express from 'express';
import { dbPromise } from '../models/db.js';

const router = express.Router();

// Calculate next billing date from a given date
function calculateNextBillingDate(billingCycle, currentDate = new Date()) {
  // Work purely in UTC so the server's timezone can't shift the date by a day.
  const date = new Date(currentDate);
  date.setUTCHours(0, 0, 0, 0);

  const cycle = (billingCycle || 'monthly').toString().toLowerCase();

  switch (cycle) {
    case 'daily':
      date.setUTCDate(date.getUTCDate() + 1);
      break;
    case 'weekly':
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case 'monthly':
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
    case 'yearly':
      date.setUTCFullYear(date.getUTCFullYear() + 1);
      break;
    case 'quarterly':
      date.setUTCMonth(date.getUTCMonth() + 3);
      break;
    default:
      date.setUTCMonth(date.getUTCMonth() + 1);
  }

  return date.toISOString().split('T')[0];
}

// Mark subscription as paid
router.put('/subscriptions/:id/mark-paid', async (req, res) => {
  const connection = await dbPromise.getConnection();

  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const {
      payment_method,
      method: methodFromClient,
      payment_date,
      amount,
      currency,
      receipt_url
    } = req.body;

    // Fetch subscription
    const [subRows] = await connection.execute(
      'SELECT * FROM subscriptions WHERE id = ?',
      [id]
    );

    if (subRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    const sub = subRows[0];

    // Normalize input
    const method = methodFromClient || payment_method || 'manual';
    const paymentDate = payment_date || new Date().toISOString().slice(0, 10);
    const effectiveAmount = amount !== undefined && amount !== null ? amount : sub.amount;
    const effectiveCurrency = currency || sub.currency;

    // Validate amount
    const amountNumber = Number(effectiveAmount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    // Use the provided payment date for paid_at
    const paidAt = `${paymentDate} 00:00:00`;

    const nextBillingDate = calculateNextBillingDate(sub.billing_cycle, new Date(paymentDate));

    // Update subscription aggregates and dates
    await connection.execute(
      `UPDATE subscriptions
       SET last_payment_date = ?,
           next_billing_date = ?,
           status = 'active',
           skipped_at = NULL,
           total_payments = COALESCE(total_payments, 0) + ?,
           payment_count = COALESCE(payment_count, 0) + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [paymentDate, nextBillingDate, amountNumber, id]
    );

    // Insert payment record (columns match your schema)
    await connection.execute(
      `INSERT INTO payments
         (user_id, subscription_id, amount, currency, payment_method, method, status, paid_at, receipt_url)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sub.user_id,
        id,
        amountNumber,
        effectiveCurrency,
        method,              // payment_method
        method,              // method
        'successful',        // status
        paidAt,              // paid_at
        receipt_url || null  // receipt_url (avoid undefined)
      ]
    );

    // Fetch updated subscription
    const [updatedSubRows] = await connection.execute(
      'SELECT * FROM subscriptions WHERE id = ?',
      [id]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: 'Payment successfully recorded',
      subscription: updatedSubRows[0]
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error marking payment as paid:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to process payment',
      details: (error && error.sqlMessage) || (error && error.message),
      code: error && error.code
    });
  } finally {
    connection.release();
  }
});

// Skip reminder (removed skip_count because it is not in your schema)
router.put('/subscriptions/:id/skip', async (req, res) => {
  try {
    const { id } = req.params;
    const { skip_duration = '1 day' } = req.body;

    const nextReminderDate = new Date();
    switch (skip_duration) {
      case '1 day':
        nextReminderDate.setDate(nextReminderDate.getDate() + 1);
        break;
      case '3 days':
        nextReminderDate.setDate(nextReminderDate.getDate() + 3);
        break;
      case '1 week':
        nextReminderDate.setDate(nextReminderDate.getDate() + 7);
        break;
      default:
        nextReminderDate.setDate(nextReminderDate.getDate() + 1);
    }

    await dbPromise.execute(
      `UPDATE subscriptions
       SET skipped_at = NOW(),
           next_reminder_date = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextReminderDate.toISOString().split('T')[0], id]
    );

    const [updatedSub] = await dbPromise.execute(
      'SELECT * FROM subscriptions WHERE id = ?',
      [id]
    );

    return res.json({
      success: true,
      message: `Reminder skipped until ${nextReminderDate.toLocaleDateString()}`,
      subscription: updatedSub[0]
    });
  } catch (error) {
    console.error('Error skipping reminder:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to skip reminder',
      details: (error && error.sqlMessage) || (error && error.message),
      code: error && error.code
    });
  }
});

// Get payment history for a subscription
router.get('/subscriptions/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [subscription] = await dbPromise.execute(
      'SELECT id, user_id FROM subscriptions WHERE id = ?',
      [id]
    );

    if (subscription.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
    }

    // query() (not execute()): MySQL 8 rejects bound LIMIT/OFFSET in prepared statements.
    const [payments] = await dbPromise.query(
      `SELECT p.*, s.name AS subscription_name, s.logo_url
       FROM payments p
       LEFT JOIN subscriptions s ON p.subscription_id = s.id
       WHERE p.subscription_id = ?
       ORDER BY p.paid_at DESC
       LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );

    const [countRows] = await dbPromise.execute(
      `SELECT COUNT(*) AS total
       FROM payments
       WHERE subscription_id = ?`,
      [id]
    );

    return res.json({
      success: true,
      payments,
      pagination: {
        total: countRows && countRows.length > 0 && countRows[0].total !== undefined ? countRows[0].total : 0,
        limit,
        offset
      }
    });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch payment history',
      details: (error && error.sqlMessage) || (error && error.message),
      code: error && error.code
    });
  }
});

// Get user payment statistics
router.get('/users/:userId/payment-stats', async (req, res) => {
  try {
    const { userId } = req.params;

    const [stats] = await dbPromise.execute(
      `SELECT
         COUNT(DISTINCT subscription_id) AS total_subscriptions,
         COUNT(*) AS total_payments,
         COALESCE(SUM(amount), 0) AS total_amount_paid,
         AVG(amount) AS average_payment,
         MIN(paid_at) AS first_payment_date,
         MAX(paid_at) AS last_payment_date
       FROM payments
       WHERE user_id = ? AND status = 'successful'`,
      [userId]
    );

    const [recentPayments] = await dbPromise.execute(
      `SELECT p.*, s.name AS subscription_name
       FROM payments p
       LEFT JOIN subscriptions s ON p.subscription_id = s.id
       WHERE p.user_id = ? AND p.status = 'successful'
       ORDER BY p.paid_at DESC
       LIMIT 5`,
      [userId]
    );

    return res.json({
      success: true,
      stats: stats[0],
      recent_payments: recentPayments
    });
  } catch (error) {
    console.error('Error fetching payment stats:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch payment statistics',
      details: (error && error.sqlMessage) || (error && error.message),
      code: error && error.code
    });
  }
});

// Get current user's payment stats
router.get('/users/current/stats', async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || 1;

    const [stats] = await dbPromise.execute(
      `SELECT
         COUNT(DISTINCT s.id) AS total_subscriptions,
         COUNT(p.id) AS total_payments,
         COALESCE(SUM(p.amount), 0) AS total_amount_paid,
         AVG(p.amount) AS average_payment
       FROM subscriptions s
       LEFT JOIN payments p
         ON s.id = p.subscription_id
         AND p.status = 'successful'
       WHERE s.user_id = ? AND s.status = 'active'`,
      [userId]
    );

    return res.json({
      success: true,
      stats: stats[0]
    });
  } catch (error) {
    console.error('Error fetching current user stats:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
      details: (error && error.sqlMessage) || (error && error.message),
      code: error && error.code
    });
  }
});

export default router;