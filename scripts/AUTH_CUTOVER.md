# คู่มือสลับระบบล็อกอิน (Cutover) — จากบัญชีกลางเป็นล็อกอินรายบุคคล

เอกสารนี้สำหรับผู้ดูแลระบบที่ไม่ใช่ผู้เชี่ยวชาญฐานข้อมูล ทำตามทีละขั้น คัดลอกคำสั่งไปวางได้เลย
ใช้เวลาประมาณ 1–2 ชั่วโมง ควรทำนอกเวลางาน และทำขั้นที่ 7–12 ให้จบในวันเดียวกัน

> **กติกาข้อแรก: ห้ามส่งรหัสผ่าน คีย์ หรือ Secret ใดๆ ในแชท/อีเมล/ไลน์**
> (service-role key, DRIVE_URL_SECRET, รหัสผ่านชั่วคราวของผู้ใช้) ค่าเหล่านี้วางได้เฉพาะในหน้า
> Vercel Environment Variables และหน้า Supabase เท่านั้น

## ภาพรวมลำดับ (ห้ามสลับ)

| ขั้น | ทำอะไร | ที่ไหน |
|---|---|---|
| 1 | ตั้งค่า Supabase Auth (ปิดสมัครเอง, รหัสผ่านอย่างน้อย 8 ตัว) | Supabase Dashboard |
| 2 | ตั้งค่า Environment Variables ฝั่งเซิร์ฟเวอร์ | Vercel |
| 3 | ตรวจสถานะฐานข้อมูลก่อนเริ่ม (Pre-flight, อ่านอย่างเดียว) | SQL Editor |
| 4 | รัน `auth-01-foundation.sql` | SQL Editor |
| 5 | ถ้ามี trigger whitelist เก่า: ปิดสมัครเองก่อน แล้วค่อยลบ trigger | SQL Editor |
| 6 | สร้างผู้ใช้คนแรก + ตั้งเป็นแอดมินด้วย `bootstrap_first_admin` | Dashboard + SQL Editor |
| 7 | Deploy แอปใหม่ | Vercel |
| 8 | สร้างแอดมินอย่างน้อย 2 คน + ผู้ใช้ทุกคน + กำหนดโปรเจกต์ | หน้า Admin ในแอป |
| 9 | ตรวจสอบด้วยมือ | แอป + SQL Editor |
| 10 | รัน `auth-test.sql` (รอบที่ 1) | SQL Editor |
| 11 | รัน `auth-02-enforce-rls.sql` (**จุดตัด: บัญชีกลางใช้ไม่ได้ทันที**) | SQL Editor |
| 12 | รัน `auth-test.sql` (รอบที่ 2) | SQL Editor |
| 13 | ปิด/ลบบัญชีกลาง `public@teamcm.co.th` และลบ `VITE_SHARED_ACCOUNT_*` | Dashboard + Vercel + `.env.local` |
| 14 | ทำ bucket `documents` (ของเก่า) ให้เป็น private | SQL Editor |
| 15 | หมุน (rotate) service-role key เป็นขั้นสุดท้าย | Supabase + Vercel |

**ข้อควรรู้:** ตั้งแต่ขั้น 7 (deploy) ผู้ใช้ต้องล็อกอินด้วยบัญชีรายบุคคลแล้ว (แอปใหม่ไม่มีบัญชีกลาง)
แต่ฐานข้อมูล *ยังไม่ล็อก* จนกว่าจะรันขั้น 11 รหัสผ่านบัญชีกลางที่ฝังอยู่ใน bundle เก่ายังใช้เปิดข้อมูลได้
จนถึงขั้นนั้น จึงต้องทำขั้น 8–12 ให้เสร็จโดยเร็ว

ไฟล์ SQL ทุกไฟล์: เปิด Supabase Dashboard → **SQL Editor** → **New query** → วางทั้งไฟล์ → **Run**
ทุกไฟล์รันซ้ำได้ปลอดภัย และทำงานใน transaction เดียว (ผิดพลาด = ไม่มีอะไรเปลี่ยน)

---

## ขั้น 1 — ตั้งค่า Supabase Auth

Supabase Dashboard → **Authentication** → (เมนูอาจชื่อ *Sign In / Providers* หรือ *Settings*)

1. ปิด **Allow new users to sign up** (OFF) — จากนี้ไม่มีใครสมัครเองได้ ผู้ใช้ใหม่สร้างผ่านหน้า Admin เท่านั้น
   **ต้องทำก่อนขั้น 5 เสมอ** (ก่อนลบ trigger whitelist)
2. ตั้ง **Minimum password length** = **8** ขึ้นไป (แนะนำ 10) แล้วกด Save
3. ปล่อย **Confirm email** ไว้ตามเดิม (แอดมินสร้างผู้ใช้แบบยืนยันอีเมลแล้ว)

**สำเร็จ:** สวิตช์ sign-up เป็น OFF และบันทึกแล้ว  **ล้มเหลว/ลืม:** ใครก็สมัครบัญชีได้ (แต่บัญชีใหม่
จะไม่มี profile จึงเข้าถึงข้อมูลไม่ได้หลังขั้น 11) — ก็ยังต้องแก้ให้ถูก

## ขั้น 2 — Environment Variables ใน Vercel

Vercel → โปรเจกต์ → **Settings** → **Environment Variables** (เลือก Production, และ Preview ถ้าใช้)

| ชื่อ | ค่า | หมายเหตุ |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → **service_role** (secret) | **ห้ามขึ้นต้นด้วย `VITE_`** ไม่งั้นจะฝังในเบราว์เซอร์ = ใครก็เป็นแอดมินได้ |
| `DRIVE_URL_SECRET` | สตริงสุ่มอย่างน้อย 32 ตัวอักษร | **ห้ามขึ้นต้นด้วย `VITE_`** |

สร้าง `DRIVE_URL_SECRET` ด้วย PowerShell (คำสั่งเดียว ผลลัพธ์ถูกคัดลอกเข้า Clipboard ไม่แสดงบนจอ
จึงวางลง Vercel ได้ทันที):

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); (-join ($b | ForEach-Object { $_.ToString('x2') })) | Set-Clipboard
```

จะได้สตริง hex 64 ตัว กด Ctrl+V ในช่อง Value ของ Vercel ทันที (อย่าบันทึกลงไฟล์หรือส่งต่อ)

ตัวแปรอื่นที่มีอยู่แล้ว (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `GOOGLE_*`, `ANTHROPIC_API_KEY`) ไม่ต้องแตะ

**ตรวจ:** ในรายการต้องมี 2 ตัวข้างบน และ *ไม่มี* ชื่อใดที่เป็น `VITE_SUPABASE_SERVICE_ROLE_KEY` หรือ `VITE_DRIVE_URL_SECRET`
(ตัวแปรใหม่จะมีผลหลัง deploy ครั้งถัดไป — ขั้น 7)

## ขั้น 3 — Pre-flight (อ่านอย่างเดียว ไม่เปลี่ยนอะไร)

รันทีละก้อนใน SQL Editor แล้วดูผล

```sql
-- 3.1 ตารางหลักเป็น uuid ทั้งคู่ (ต้องเห็น data_type = uuid)
select table_name, column_name, data_type from information_schema.columns
where table_schema='public' and table_name in ('projects','files') and column_name='id';

-- 3.2 trigger ที่ค้างอยู่บน auth.users (ถ้ามี enforce_email_whitelist = ต้องทำขั้น 5)
select tgname, tgenabled from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal;

-- 3.3 ไฟล์ที่ storage_path ซ้ำกัน (ควรได้ 0 แถว; ถ้ามี script จะข้ามการสร้าง unique index และแจ้งจำนวน)
select storage_path, count(*) from public.files
where storage_path is not null and storage_path <> '' group by 1 having count(*) > 1;

-- 3.4 ผู้ใช้ที่มีอยู่แล้วใน Auth (ควรเห็นบัญชีกลาง public@teamcm.co.th)
select email, created_at, last_sign_in_at from auth.users order by created_at;
```

**สำเร็จ:** 3.1 เป็น uuid, 3.3 ว่าง  **ผิดปกติ:** 3.1 ไม่ใช่ uuid → หยุด อย่ารันต่อ ถามผู้พัฒนา

## ขั้น 4 — รัน `scripts/auth-01-foundation.sql`

วางทั้งไฟล์ → Run

ไฟล์นี้ **เพิ่มอย่างเดียว** ปลอดภัยขณะแอปเก่ายังใช้งานอยู่ (ไม่ปิดสิทธิ์ใคร) สิ่งที่สร้าง: ตาราง `profiles`,
`project_members`, `audit_log`, ฟังก์ชันตรวจสิทธิ์, trigger กันลบ/ลดสิทธิ์แอดมินคนสุดท้าย,
ระบบบังคับเปลี่ยนรหัสผ่านชั่วคราว, ฟังก์ชัน `revoke_user_sessions`, unique index ของ `files.storage_path`

**สำเร็จ:** แท็บ Results แสดงตาราง 1 แถว คอลัมน์ `check_name | status`
- `status = OK (not installed)` → ไปขั้น 6 ได้เลย
- `status = STILL INSTALLED - ...` → ต้องทำขั้น 5 ก่อนขั้น 6

และใน Messages/Notices จะเห็น `auth-01 self-check OK ...` ถ้า trigger whitelist ยังอยู่จะมี `WARNING: ACTION REQUIRED ...`
พร้อมคำสั่งที่ต้องรัน (คือคำสั่งในขั้น 5)

**ล้มเหลว:** ขึ้น `ERROR: ...` สีแดง = ไม่มีอะไรเปลี่ยนเลย (transaction ถูกยกเลิก) คัดลอกข้อความ error
(ไม่มีความลับในนั้น) ส่งให้ผู้พัฒนา ห้ามรันขั้นถัดไป
- `canceling statement due to lock timeout` → มีคนกำลังใช้งานหนัก รอ 1–2 นาทีแล้วรันซ้ำได้
- `files_storage_path_uq SKIPPED: n duplicated ...` ไม่ใช่ error — แค่ข้ามการสร้าง unique index
  (แก้รายการซ้ำตาม 3.3 แล้วรัน auth-01 ซ้ำเมื่อสะดวก)

## ขั้น 5 — จัดการ trigger whitelist เก่า (ทำเฉพาะเมื่อขั้น 4 แจ้งว่า STILL INSTALLED)

trigger `enforce_email_whitelist` (จาก `whitelist-emails.sql`) ปฏิเสธการสร้างผู้ใช้ที่อีเมลไม่อยู่ใน
`allowed_emails` ทำให้ปุ่ม "สร้างผู้ใช้" ในหน้า Admin ล้มเหลวด้วยข้อความ error ทั่วไป และเพิ่มขึ้นมาเป็น
ประตูเสริมตอน sign-up เปิดอยู่เท่านั้น — ตอนนี้ประตูหลักคือตาราง `profiles`

**ลำดับที่ปลอดภัย (สำคัญ):**
1. ยืนยันว่าขั้น 1 ปิด "Allow new users to sign up" แล้ว (OFF) — **ถ้ายังเปิดอยู่ ห้ามลบ trigger**
   เพราะระหว่างที่ไม่มี trigger ใครก็สมัครได้
2. จึงรัน:

```sql
drop trigger if exists enforce_email_whitelist on auth.users;
drop function if exists public.check_email_allowed();
```

3. ตรวจ:

```sql
select tgname from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal;
```

**สำเร็จ:** ไม่เห็น `enforce_email_whitelist` (ผลว่างเปล่า หรือมีเฉพาะ trigger อื่นที่ไม่เกี่ยวกับ whitelist)
**ล้มเหลว:** `must be owner of ...` → ต้องรันด้วย role postgres ใน SQL Editor (ค่าเริ่มต้นเป็นอยู่แล้ว)
**ทางเลือก (ถ้าไม่อยากลบ trigger):** เพิ่มอีเมลของผู้ใช้ใหม่ทุกคนใน `allowed_emails` *ก่อน* สร้างผู้ใช้ทุกครั้ง
(ไม่แนะนำ ลืมแล้ว error ทั่วไปอีก)

หมายเหตุ: ตาราง `allowed_emails` ปล่อยไว้ได้ ไม่มีผลหลังลบ trigger

## ขั้น 6 — สร้างผู้ใช้คนแรก และตั้งเป็นแอดมิน

1. Dashboard → **Authentication** → **Users** → **Add user** → **Create new user**
   ใส่อีเมลของคุณเอง + รหัสผ่านที่ยาวและคาดเดายาก (อย่างน้อย 10 ตัว) และติ๊ก **Auto Confirm User** → Create
   - ถ้าขึ้นข้อความภาษาไทย "อีเมลนี้ไม่ได้รับอนุญาต..." แปลว่ายังไม่ได้ทำขั้น 5
2. ใน SQL Editor รัน (แก้อีเมลเป็นของคุณ):

```sql
select public.bootstrap_first_admin('your-email@example.com');
```

**สำเร็จ:** ได้ข้อความ `OK: your-email@example.com (....) is now an active admin`
**ล้มเหลว:** `No auth user with email ...` → อีเมลสะกดผิด หรือยังไม่ได้สร้างผู้ใช้ในขั้น 1

บัญชีนี้ไม่ต้องเปลี่ยนรหัสผ่านซ้ำ (ไม่ถูกบังคับ) — แต่ควรเป็นรหัสผ่านที่คุณตั้งเองและไม่ใช้ซ้ำที่อื่น

## ขั้น 7 — Deploy แอปใหม่

```
npm run deploy
```
(หรือ push ขึ้น Git ให้ Vercel build) แล้วเปิดเว็บ → ต้องเห็นหน้า **ล็อกอิน** (ไม่ใช่เข้าอัตโนมัติ)
ล็อกอินด้วยบัญชีแอดมินในขั้น 6 → เห็นเมนู Admin

**สำเร็จ:** ล็อกอินได้ เห็นโปรเจกต์ทั้งหมด และมีหน้า Admin
**ล้มเหลว:** หน้า Admin ขึ้น error ตอนโหลดผู้ใช้ → เช็กว่า `SUPABASE_SERVICE_ROLE_KEY` ตั้งใน Vercel แล้วและ deploy ใหม่หลังตั้ง
(ตัวแปรใหม่มีผลเฉพาะ deployment ใหม่)

## ขั้น 8 — สร้างแอดมินสำรอง ผู้ใช้ และกำหนดโปรเจกต์ (ผ่านหน้า Admin)

1. สร้างผู้ใช้ **role = admin อีกอย่างน้อย 1 คน** (รวมเป็น ≥ 2 แอดมิน) — ระบบจะไม่ยอมให้ลบ/ลดสิทธิ์/ปิดใช้งาน
   แอดมินคนสุดท้าย (กันล็อกตัวเองออก) แต่ถ้ามีคนเดียว คุณก็หมุนบัญชีไม่ได้
   **แอดมินคนที่สองจะนับเป็น "ตัวสำรอง" ก็ต่อเมื่อเขาล็อกอินและตั้งรหัสผ่านใหม่แล้วเท่านั้น**
   (แอดมินที่ยังถือรหัสชั่วคราวใช้ระบบไม่ได้จริง ฐานข้อมูลจึงไม่นับ — ถ้าลองลดสิทธิ์/ปิดใช้งานคุณเองตอนนั้น
   จะขึ้น `LAST_ADMIN: ...`) ให้นัดแอดมินคนที่สองล็อกอินและเปลี่ยนรหัสให้เรียบร้อยก่อนขั้น 11
2. สร้างผู้ใช้อื่นทุกคน เลือก role:
   - `admin` แก้ได้ทุกอย่าง ทุกโปรเจกต์ + จัดการผู้ใช้
   - `exec` ดูได้ทุกโปรเจกต์ ไม่มีสิทธิ์แก้
   - `user` เห็น/แก้เฉพาะโปรเจกต์ที่กำหนด (editor = แก้ได้, viewer = ดูอย่างเดียว)
3. ผู้ใช้ role `user` ทุกคนต้องถูกกำหนดโปรเจกต์ (ไม่กำหนด = มองไม่เห็นอะไรเลย)
4. ระบบแสดงรหัสผ่านชั่วคราว **ครั้งเดียว** ต่อผู้ใช้ — ส่งให้เจ้าตัวแบบตัวต่อตัว (โทร/พบหน้า) ห้ามพิมพ์ในแชทกลุ่ม
5. ผู้ใช้ที่ได้รหัสชั่วคราวจะเห็นหน้า "ตั้งรหัสผ่านใหม่" ตอนล็อกอินครั้งแรก ให้ตั้งรหัสใหม่อย่างน้อย 8 ตัว
   **ข้อควรระวัง:** การที่ "ฐานข้อมูลปิดกั้นข้อมูลจนกว่าจะเปลี่ยนรหัสผ่านจริง" มีผล **เฉพาะหลังรัน
   `auth-02` (ขั้น 11) เท่านั้น** ก่อนหน้านั้นนโยบายเก่า (`using (true)`) ยังเปิดอยู่ ผู้ใช้ที่ล็อกอินได้ (รวมคนที่ยังถือ
   รหัสชั่วคราว) ยังอ่าน/เขียนข้อมูลผ่านฐานข้อมูลตรงๆ ได้ และข้อจำกัด exec/viewer มีผลแค่ที่หน้าจอ
   → **อย่าแจกบัญชีให้พนักงานจริง และอย่าเริ่มพึ่งสิทธิ์ exec/viewer ก่อน auth-02** ช่วงขั้น 8–10 ให้สร้างเฉพาะ
   บัญชีทดสอบ/ผู้ดูแล แล้วค่อยแจกบัญชีพนักงานหลังขั้น 12 ผ่าน
6. **กรณีมีบัญชีใน Auth อยู่แล้วแต่ยังไม่มี profile** (เช่น พนักงานที่เคยอยู่ใน whitelist และเคยสมัครไว้) —
   ตอนสร้างผู้ใช้ด้วยอีเมลนั้น หน้า Admin จะถามยืนยัน ("อีเมลนี้มีบัญชีอยู่แล้ว ใช้บัญชีเดิม?") และแสดงเวลาล็อกอินล่าสุด
   ถ้ากดยืนยัน ระบบจะ **รับบัญชีเดิมมาใช้** (id เดิม จึงยังเชื่อมกับไฟล์/ประวัติเก่า) โดย:
   - ตั้ง **รหัสผ่านชั่วคราวใหม่** (รหัสเดิมใช้ไม่ได้อีก) และยกเลิกการแบน (ถ้ามี)
   - **ล้าง session เดิมทั้งหมด** (ใครถือ session เก่าอยู่จะถูกเตะออก)
   - สร้าง profile ตาม role ที่เลือก และบังคับเปลี่ยนรหัสผ่าน
   ตรวจให้แน่ใจว่าเป็นอีเมลของคนนั้นจริง ถ้าเวลาล็อกอินล่าสุดดูแปลก (เช่นเพิ่งมีคนใช้ทั้งที่เจ้าตัวไม่เคยล็อกอิน)
   ให้ยกเลิกและสอบถามก่อน **ห้ามใช้วิธีนี้กับ `public@teamcm.co.th`** (บัญชีกลาง — ปิดตามขั้น 13)

## ขั้น 9 — ตรวจสอบด้วยมือ

**9.0 ทดสอบการบังคับเปลี่ยนรหัสผ่านกับผู้ใช้จริงคนแรก (ทำครั้งเดียว ใช้เวลา 2 นาที)** — ป้องกันกรณี Supabase เปลี่ยน hash
รหัสผ่านเองตอนล็อกอิน (ซึ่งจะทำให้ระบบนึกว่า "เปลี่ยนรหัสแล้ว"):
1. สร้างผู้ใช้ทดสอบจากหน้า Admin (ได้รหัสชั่วคราว) แล้วล็อกอินด้วยรหัสนั้น ได้หน้า "ตั้งรหัสผ่านใหม่" — **ยังไม่ต้องตั้งรหัสใหม่**
2. ใน SQL Editor รันทั้งก้อนนี้ (แก้อีเมลเป็นของผู้ใช้ทดสอบ) — ทำเหมือนที่แอปจะเรียกในนามผู้ใช้คนนั้น และ **ยกเลิก (rollback) ท้ายสุดเสมอ**:
   ```sql
   begin;
   select set_config('request.jwt.claims',
     json_build_object('sub', (select id from auth.users where lower(email) = lower('test-user@example.com')),
                       'role', 'authenticated')::text, true);
   set local role authenticated;
   select public.clear_must_change_password();
   rollback;
   ```
3. **ผลที่ถูกต้อง:** ได้ error ที่มีข้อความ `PASSWORD_NOT_CHANGED` (code `P0001`) และผู้ใช้ทดสอบยังค้างที่หน้า "ตั้งรหัสผ่านใหม่"
4. **ผลที่ผิด:** ไม่มี error (สำเร็จทั้งที่ยังไม่เปลี่ยนรหัส) แปลว่าตรวจการเปลี่ยนรหัสไม่ได้ผลกับระบบของคุณ →
   **หยุด ห้ามรันขั้น 11** แจ้งผู้พัฒนา (ระหว่างนี้ให้ถือว่าการบังคับเปลี่ยนรหัสเป็นแค่คำแนะนำที่หน้าจอ ไม่ใช่การป้องกัน
   และต้องส่งรหัสชั่วคราวแบบตัวต่อตัวเท่านั้น) แล้วตั้งรหัสใหม่ปกติเพื่อเก็บบัญชีทดสอบ

ใน SQL Editor:

```sql
-- ทุกคนที่ควรใช้ระบบ ต้องอยู่ในนี้ และต้องมี admin active อย่างน้อย 2
select email, role, active, must_change_password from public.profiles order by role, email;

-- user ที่ไม่มีโปรเจกต์เลย (ควรไม่มี ยกเว้นตั้งใจ)
select p.email from public.profiles p
where p.role = 'user' and p.active
  and not exists (select 1 from public.project_members m where m.user_id = p.id);

-- บัญชีใน Auth ที่ไม่มี profile (ควรเหลือแค่ public@teamcm.co.th)
select u.email from auth.users u left join public.profiles p on p.id = u.id where p.id is null;
```

ในแอป: ล็อกอินเป็นผู้ใช้ทดสอบ role `user` หนึ่งคน (ที่ตั้งรหัสใหม่แล้ว) → ต้องเห็นเฉพาะโปรเจกต์ที่กำหนด
และ role `exec` → เห็นทุกโปรเจกต์แต่แก้ไม่ได้

## ขั้น 10 — `scripts/auth-test.sql` (รอบที่ 1, หลัง auth-01)

วางทั้งไฟล์ → Run

> **ผลลัพธ์คือข้อความ ERROR — นี่คือปกติ** ข้อความขึ้นต้นด้วย `AUTH TEST (all data rolled back...)`
> ไฟล์ตั้งใจให้ error ตอนท้ายเพื่อยกเลิกข้อมูลทดสอบทั้งหมด (ไม่มีข้อมูลจริงถูกแก้)

**สำเร็จ:** บรรทัดสรุป `== SUMMARY: N PASS, 0 FAIL, 1 SKIP ==` (SKIP 1 รายการ = ส่วน RLS ของตารางข้อมูล
ซึ่งจะทดสอบหลัง auth-02) และส่วน `--- FAILURES ---` เป็น `(none)`
**ล้มเหลว:** `FAIL` ≥ 1 หรือ error ที่ไม่ได้ขึ้นต้นด้วย `AUTH TEST` → **หยุด ห้ามรันขั้น 11** ส่งข้อความให้ผู้พัฒนา
(มีข้อความ `Cannot seed` = Supabase ไม่ให้เพิ่มแถวทดสอบใน auth.users ให้ส่งต่อผู้พัฒนาเช่นกัน)

ไฟล์นี้ล็อกตาราง audit_log ช่วงสั้นๆ ตอนท้าย รันนอกเวลาที่มีคนใช้หนัก

## ขั้น 11 — `scripts/auth-02-enforce-rls.sql` (จุดตัด)

**ก่อนรัน เช็กลิสต์:** [ ] auth-01 รันแล้ว  [ ] มีแอดมิน active ≥ 2 คน และ **อย่างน้อย 1 คนนอกจากคุณล็อกอินและตั้งรหัสผ่านใหม่แล้ว**  [ ] ทำ 9.0 แล้ว  [ ] แอปใหม่ deploy แล้ว
[ ] ผู้ใช้ทุกคนมี profile และผู้ใช้ role `user` มีโปรเจกต์  [ ] ขั้น 10 ไม่มี FAIL
[ ] เปิดแท็บ SQL Editor อีกแท็บเตรียม `auth-03-rollback.sql` ไว้ (ยังไม่ต้องรัน)

วางทั้งไฟล์ → Run

**ผลทันที:** บัญชีกลาง `public@teamcm.co.th` และแอปเก่าที่เปิดค้างอยู่ จะอ่าน/เขียนข้อมูลไม่ได้ในคำสั่งถัดไป
**สำเร็จ:** Messages แสดง `preflight OK: N active admin(s)`, `dropped N existing policies`, สรุปจำนวน policy ต่อตาราง
และ `WARNING: auth user public@teamcm.co.th has NO profile` (คาดไว้ ถูกต้อง) แล้วจบโดยไม่มี ERROR
**ล้มเหลว:** `ABORTED: there is no ACTIVE admin ...` หรือ `Missing function/trigger/column ... Run the CURRENT auth-01`
→ ไม่มีอะไรเปลี่ยน ทำตามข้อความ (ส่วนใหญ่คือรัน auth-01 ฉบับล่าสุดซ้ำ) ถ้ามี `WARNING: ... has ROW LEVEL SECURITY OFF`
หรือ `anon can EXECUTE function ...` ให้คัดลอกส่งผู้พัฒนา

## ขั้น 12 — `scripts/auth-test.sql` (รอบที่ 2, หลัง auth-02)

รันเหมือนขั้น 10 **คาดหวัง:** `0 FAIL, 0 SKIP` (ตอนนี้ไม่มี SKIP แล้ว เพราะ RLS บังคับใช้แล้ว)
**ล้มเหลว (FAIL ≥ 1 หรือผู้ใช้จริงเข้าไม่ได้):** ถ้าเป็นเพียงข้อมูลผิด (ไม่มี profile / ไม่มีโปรเจกต์) แก้ที่หน้า Admin
ได้เลย การแก้ข้อมูลง่ายกว่ากลับไปทั้งระบบ — ถ้าแก้ไม่ได้ ดู "ทางถอย" ด้านล่าง

จากนั้นทดสอบในแอปอีกครั้ง: ผู้ใช้ `user`, `exec`, `admin` อย่างละคน อัปโหลดไฟล์ในโปรเจกต์ที่เป็น editor ได้,
ในโปรเจกต์ที่เป็น viewer อัปโหลดไม่ได้

## ขั้น 13 — ปิดบัญชีกลาง และลบตัวแปรเก่า

รหัสผ่านของ `public@teamcm.co.th` ถูกฝังอยู่ใน JavaScript bundle ของแอปเก่า ถือว่า **เป็นความลับที่รั่วแล้ว**
ต้องปิดบัญชีนี้ (แม้ขั้น 11 จะทำให้บัญชีนี้ไม่เห็นข้อมูลแล้ว):

```sql
-- ปิดบัญชี (ban) + เตะ session ที่ค้างอยู่ทั้งหมด
update auth.users set banned_until = now() + interval '100 years' where lower(email) = 'public@teamcm.co.th';
select public.revoke_user_sessions(id) from auth.users where lower(email) = 'public@teamcm.co.th';
```

แล้วเข้า Dashboard → Authentication → Users → ค้นหา `public@teamcm.co.th` → **Delete user**
(ถ้ายังไม่แน่ใจ ให้ ban ไว้ก่อน 1 สัปดาห์แล้วค่อยลบ — แต่ *ห้าม* เปิดบัญชีนี้กลับมา)

จากนั้น:
1. Vercel → Settings → Environment Variables → ลบ `VITE_SHARED_ACCOUNT_EMAIL` และ `VITE_SHARED_ACCOUNT_PASSWORD`
   (ทุก Environment) แล้ว Redeploy
2. ไฟล์ `.env.local` ในเครื่อง → ลบสองบรรทัดเดียวกันนี้
3. ค้นดูว่าไม่เหลือในโค้ด/ไฟล์ที่ commit (PowerShell ที่โฟลเดอร์โปรเจกต์):
   `Select-String -Path .env*,src\*,api\* -Pattern "SHARED_ACCOUNT" -Recurse` ต้องไม่พบ (ยกเว้นข้อความหมายเหตุใน `.env.example`)

**สำเร็จ:** ลองล็อกอินด้วยบัญชีนั้นไม่ได้ (invalid/banned) และ build ใหม่ไม่มีข้อความ `SHARED_ACCOUNT`

## ขั้น 14 — bucket `documents` (Supabase Storage เก่า) ให้เป็น private

แอปเก็บไฟล์จริงใน Google Drive แล้ว แต่ถ้ายังมี bucket `documents` แบบ public ใน Supabase ไฟล์เก่าในนั้นเปิดได้ด้วยลิงก์
ใครมีลิงก์ก็ดูได้ แม้ RLS จะล็อกแล้ว ตรวจก่อน:

```sql
select id, public from storage.buckets;
```

- ไม่มีแถว `documents` → จบขั้นนี้
- มี `documents` และ `public = true` และไม่มีอะไรใช้ไฟล์ในนั้นแล้ว (ตรวจว่า `files.storage_path` ไม่ได้ชี้เข้า bucket นี้ — ปัจจุบันเป็น Drive file id) รัน:

```sql
update storage.buckets set public = false where id = 'documents';
```

**สำเร็จ:** ลองเปิดลิงก์ public เดิมของไฟล์หนึ่งไฟล์ → ต้องขึ้น error (Bucket not found / not authorized)
**ถ้ามีไฟล์เก่าที่ยังต้องใช้:** อย่าเพิ่งเปลี่ยน แจ้งผู้พัฒนาให้ย้ายไป Drive ก่อน (`scripts/migrate-storage-to-drive.mjs`)

## ขั้น 15 — หมุน service-role key (ขั้นสุดท้าย)

เหตุผล: คีย์นี้เคยผ่านมือหลายคน/หลายเครื่องระหว่างการตั้งค่า การหมุนทำให้คีย์เก่าใช้ไม่ได้
1. Supabase → Settings → **API** (หรือ *API Keys*) → หมุน/สร้าง **service_role (secret) key** ใหม่
   - ถ้าหน้าจอของคุณมีเฉพาะ "JWT secret rotate" แบบเก่า การหมุนจะเปลี่ยน anon key ด้วย ต้องอัปเดต
     `VITE_SUPABASE_ANON_KEY` และ `SUPABASE_SERVICE_ROLE_KEY` ใน Vercel ทั้งคู่ แล้ว Redeploy
     ผู้ใช้ทุกคนจะถูกให้ล็อกอินใหม่ (ปกติ)
2. คัดลอกคีย์ใหม่ (อย่าวางในแชท) → Vercel → แก้ `SUPABASE_SERVICE_ROLE_KEY` → **Redeploy**
3. ทดสอบ: หน้า Admin โหลดรายชื่อผู้ใช้ได้, สร้าง/รีเซ็ตผู้ใช้ทดสอบได้

**สำเร็จ:** หน้า Admin ทำงาน  **ล้มเหลว:** หน้า Admin ขึ้น error 500/`server_misconfigured` → ค่าใน Vercel ผิดหรือยังไม่ได้ Redeploy

---

## ทางถอย (Rollback)

ใช้เมื่อหลังขั้น 11 มีคนเข้าไม่ได้และแก้ที่หน้า Admin ไม่ได้ **ข้อมูลที่ขาด profile/โปรเจกต์แก้ด้วยการเพิ่มแถวเดียว
ไม่ควรถอยทั้งระบบ** ตัวอย่างปลดล็อกคนเดียว:

```sql
-- ปลดการบังคับเปลี่ยนรหัสผ่านของคนที่เปลี่ยนรหัสเรียบร้อยแล้วแต่ค้าง
update public.profiles set must_change_password = false where email = 'someone@example.com';
```

ถอยทั้งระบบ: เปิด `scripts/auth-03-rollback.sql` แล้วแก้ที่บรรทัด `create temp table _tcm_rollback_mode`:

| mode | ผล | ใช้เมื่อ |
|---|---|---|
| `admin_only` (**แนะนำ**) | ผ่อนเป็นนโยบายที่ให้เฉพาะแอดมินเข้าได้ทุกอย่าง บัญชีกลางไม่ถูกเปิด | ต้องการให้แอดมินทำงานต่อระหว่างแก้ปัญหา |
| `repo` | เปิดให้ **บัญชีกลาง public@teamcm.co.th** + แอดมิน | ต้องเอาแอปเก่ากลับมาจริงๆ เท่านั้น |
| `backup` | เล่นนโยบายเดิมที่สำรองไว้ตอน auth-02 (อาจเป็น `using (true)` = ใครล็อกอินก็ได้) | ต้องการสภาพเดิมเป๊ะ |

**คำเตือน:** `repo` และ `backup` เปิดข้อมูลให้บัญชีกลางซึ่งรหัสผ่านรั่วอยู่แล้ว สคริปต์จึง *ปฏิเสธการทำงาน* จนกว่าจะแก้
`accept_shared_risk` เป็นข้อความ `I-ACCEPT-THE-RISK` ด้วยตัวเอง และก่อนรันต้องมั่นใจว่าปิด sign-up แล้ว
ใช้เพียงชั่วคราว (เป็นชั่วโมง ไม่ใช่วัน) แล้วกลับไปรัน auth-02 ใหม่ทันทีที่แก้ปัญหาเสร็จ
(ถ้าไม่ได้เปิดบัญชีกลางไว้ — เช่นถูก ban ในขั้น 13 — แอปเก่าก็ใช้ไม่ได้อยู่ดี ให้ใช้ `admin_only`)

`undo_hardening = 'YES'` (ปกติ `'NO'`) จะถอด trigger กันแอดมินคนสุดท้าย, คอลัมน์ `pw_marker`, ฟังก์ชัน
`set_pw_marker` / `revoke_user_sessions` และ unique index ของ `storage_path` ด้วย ใช้เฉพาะเมื่อถอยกลับไปแอปเวอร์ชันเก่าจริงๆ
เพราะแอปใหม่เรียกฟังก์ชันเหล่านั้นอยู่

หลังรัน auth-03: SQL Editor ตรวจ `select tablename, policyname from pg_policies where schemaname='public' order by 1,2;`
ผล: จะเห็น policy ชุดที่ auth-03 สร้าง

---

## สรุปพฤติกรรมความปลอดภัยที่ควรรู้ (สำหรับผู้ดูแล)

- **รหัสผ่านชั่วคราว (หลัง auth-02 เท่านั้น):** ผู้ใช้ที่เพิ่งถูกสร้าง/รีเซ็ตรหัสผ่านโดยแอดมินจะ *ไม่เห็นข้อมูลใดๆ ในฐานข้อมูล*
  จนกว่าจะเปลี่ยนรหัสผ่านจริง **ก่อนรัน auth-02 ข้อนี้ยังไม่มีผล** (นโยบายเก่าเปิดอยู่ ดูขั้น 8 ข้อ 5)
  หน้าจอ "ตั้งรหัสผ่านใหม่" ทำงานได้ปกติ และหากเรียกยืนยันโดยไม่เปลี่ยนรหัสจริงจะถูกปฏิเสธ (`PASSWORD_NOT_CHANGED`)
  การรีเซ็ตรหัสผ่านโดยแอดมินทำตามลำดับ `begin_password_reset` → เขียนรหัสใหม่ → ล้าง session → `set_pw_marker`
  ถ้าขั้นตอนค้างกลางทาง ผู้ใช้จะยังเข้าไม่ได้ (ปลอดภัย) ให้แอดมินกดรีเซ็ตซ้ำ
- **แอดมินคนสุดท้าย:** ลบ/ลดสิทธิ์/ปิดใช้งาน/รีเซ็ตรหัสแล้วจะไม่เหลือแอดมิน *ที่ใช้งานได้จริง* (active และเปลี่ยนรหัสชั่วคราวแล้ว)
  → ถูกปฏิเสธด้วยข้อความ `LAST_ADMIN: ...`
  (ใช้ได้กับทุกช่องทาง รวมถึง service-role) ถ้าเกิดเหตุจนไม่มีแอดมินใช้งานได้จริง กู้ด้วย
  `select public.bootstrap_first_admin('อีเมล');` ใน SQL Editor
- **ปิดการใช้งานผู้ใช้:** ข้อมูลถูกปิดทันที (profile active = false) ส่วน access token ที่ออกไปแล้วอาจยังอยู่ได้อีกไม่เกิน
  ประมาณ 1 ชั่วโมง แต่ทำอะไรกับข้อมูลไม่ได้ และ refresh ไม่ได้เพราะ session ถูกลบ (`revoke_user_sessions`)
- **ประวัติการใช้งาน (audit_log):** อ่านได้เฉพาะแอดมิน ห้ามแก้/ลบจากแอป การเปลี่ยน `files.uploader_id` ก็ถูกบันทึกด้วย
  และผู้ใช้ตั้งค่านี้เป็นของคนอื่นไม่ได้ (เฉพาะ NULL หรือ id ตัวเอง)
- **ตาราง profiles จากฝั่งเบราว์เซอร์:** อ่านได้เฉพาะคอลัมน์ที่ระบุชื่อ (`select=id,email,...`) การใช้ `select=*` จะถูกปฏิเสธ
  เพราะคอลัมน์ `pw_marker` (ลายนิ้วมือของรหัสผ่านชั่วคราว) ถูกซ่อนจากผู้ใช้ทุกคน รวมถึงแอดมิน
