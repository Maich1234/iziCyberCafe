import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresSQL, createDatabase } from '../src/database.js';

test('PostgreSQL translation preserves bound values, joins and idempotent print inserts', () => {
  assert.equal(postgresSQL("SELECT users.id FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND role='what?''s' AND expires>?"),
    "SELECT users.id FROM izicybercafe.sessions JOIN izicybercafe.users ON users.id=sessions.user_id WHERE token=$1 AND role='what?''s' AND expires>$2");
  assert.equal(postgresSQL('INSERT OR IGNORE INTO print_jobs(order_id,file_id) VALUES(?,?)'),
    'INSERT INTO izicybercafe.print_jobs(order_id,file_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id');
  assert.equal(postgresSQL('INSERT INTO sessions VALUES(?,?,?)'), 'INSERT INTO izicybercafe.sessions VALUES($1,$2,$3)');
  assert.equal(postgresSQL('SELECT substr(phone,-4) FROM payment_attempts ORDER BY rowid DESC'),
    'SELECT right(phone,4) FROM izicybercafe.payment_attempts ORDER BY sequence_id DESC');
});

test('asynchronous local requests retain transaction isolation', async () => {
  const db=await createDatabase();
  try {
    db.exec('CREATE TABLE sample(value INTEGER)');
    let release, started;
    const waiting=new Promise(r=>release=r), active=new Promise(r=>started=r);
    const first=db.scope(async()=>{db.exec('BEGIN');db.prepare('INSERT INTO sample VALUES(?)').run(1);started();await waiting;db.exec('ROLLBACK');});
    await active;
    const second=db.scope(async()=>{db.prepare('INSERT INTO sample VALUES(?)').run(2);});
    release();await Promise.all([first,second]);
    assert.deepEqual(db.prepare('SELECT value FROM sample').all().map(r=>r.value),[2]);
  }finally{await db.close();}
});
