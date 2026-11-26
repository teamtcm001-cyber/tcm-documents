# สวิตช์ "โครงการนี้มีงวดเบิก" (projects.has_installments)

บางโครงการ (เช่น โครงการแบบ Hybrid) ไม่มีงวดเบิก (งวด Pre-con ฯลฯ) สวิตช์นี้ใช้บอกระบบว่า
"โครงการนี้ไม่มีงวดงาน" เพื่อให้หน้าติดตามโครงการ กฎสุขภาพโครงการ และ AI chat ไม่นับว่า "ขาดข้อมูลงวดงาน"

- คอลัมน์ใหม่ `public.projects.has_installments` (boolean, ไม่เป็น null, ค่าเริ่มต้น `true`)
  โครงการเดิมทั้งหมดได้ค่า `true` = ทำงานเหมือนเดิมทุกอย่าง
- เมื่อเป็น `false`: view `project_tracking_overview` จะแสดงค่าที่มาจากงวดงานเป็น 0 / ว่าง
  (`installments_total/_billed/_overdue/_returned` = 0, `next_*` = NULL) จึงไม่มีกฎเรื่องงวดงานใดทำงาน
- **ไม่มีการลบข้อมูล**: แถวงวดงานและรายการเอกสารยังอยู่ครบ (และยังเห็นใน `installment_summary`)
  เปิดสวิตช์กลับเป็น `true` เมื่อไรก็แสดงเหมือนเดิมทันที
- view ทั้งสาม (`project_progress_latest`, `installment_summary`, `project_tracking_overview`) มีคอลัมน์
  `has_installments` เพิ่มเป็น **คอลัมน์สุดท้าย** คอลัมน์เดิมไม่เปลี่ยนชื่อ/ชนิด/ลำดับ สิทธิ์ (grant) และ
  `security_invoker = on` คงเดิม

## ใครเปลี่ยนสวิตช์ได้ (ตัดสินใจโดยผู้ใช้: เฉพาะแอดมิน และผู้ดูแลโครงการ)

ฐานข้อมูลบังคับเอง 2 ชั้น: RLS เดิมของ `projects` (`projects_update` = `can_edit_project`) กำหนดว่าเห็น/แก้แถวไหนได้
และ trigger `trg_projects_billing_flag_guard` อนุญาตให้ **เปลี่ยนค่า** `has_installments` ได้เฉพาะแอดมินหรือผู้ดูแลโครงการนั้น

| บทบาท | เปลี่ยนสวิตช์ได้ | ผลเมื่อพยายามเปลี่ยน |
|---|---|---|
| Admin | ได้ทุกโครงการ | สำเร็จ |
| ผู้ดูแลโครงการ (manager) ของโครงการนั้น | ได้ | สำเร็จ |
| แก้ไขได้ (editor) ของโครงการนั้น | **ไม่ได้** (ยังแก้ข้อมูลอื่นของโครงการได้ตามเดิม) | error 42501 `BILLING_FLAG_FORBIDDEN` ทั้งคำสั่งถูกยกเลิก ไม่มีอะไรเปลี่ยน |
| ผู้ดูแลโครงการ "อื่น" ที่ไม่มีสิทธิ์แก้โครงการนี้, ดูอย่างเดียว (viewer), Exec, คนที่ไม่ใช่สมาชิก | ไม่ได้ | อัปเดต 0 แถว (RLS ซ่อนแถว) ค่าไม่เปลี่ยน |
| ผู้ดูแลโครงการอื่นที่เป็น editor ของโครงการนี้ | ไม่ได้ | error 42501 `BILLING_FLAG_FORBIDDEN` |

ข้อความ error ที่หน้าเว็บได้รับ (PostgREST, HTTP 403):
`code = 42501`, `message = BILLING_FLAG_FORBIDDEN`,
`details = เฉพาะแอดมินหรือผู้ดูแลโครงการเท่านั้นที่เปิด/ปิดการตั้งค่าไม่มีงวดเบิกได้`

หมายเหตุ
- ส่งค่าเดิม (ไม่เปลี่ยน) มาพร้อมฟอร์มได้ ไม่นับว่าเปลี่ยน — editor บันทึกฟอร์มที่มี `has_installments` ค่าเดิมได้ตามปกติ
- การแก้จาก SQL Editor หรือ service role (ไม่มีผู้ใช้ล็อกอิน) ไม่ถูกจำกัด
- ถ้ายังไม่ได้รัน `auth-04-project-managers.sql` จะเปลี่ยนได้เฉพาะแอดมิน
- ช่วงที่ใช้ `auth-03-rollback.sql` (บัญชีกลาง) บัญชีกลางไม่ใช่แอดมิน จึงเปลี่ยนสวิตช์ไม่ได้ — ให้แอดมินเปลี่ยนแทน

ทุกครั้งที่เปลี่ยนสำเร็จ จะมีบันทึกใน `audit_log` (table `projects`, action `update`,
details `{"has_installments": {"old": true, "new": false}}` พร้อมผู้ที่เปลี่ยน) ครั้งที่ถูกปฏิเสธไม่มีบันทึก (ไม่มีอะไรเปลี่ยน)

## วิธีรัน

1. Supabase Dashboard -> SQL Editor -> New query
2. วางเนื้อหาทั้งไฟล์ `scripts/project-billing-flag.sql` -> Run
3. ผลลัพธ์สุดท้ายเป็นตาราง `project_code, has_installments, installments_total, next_installment_no`
   ทุกโครงการต้องเป็น `true` และตัวเลขเหมือนเดิม และใน Messages ต้องมี `project-billing-flag self-check OK.`

หมายเหตุ
- ต้องรัน `scripts/project-tracking.sql` มาก่อน (ระบบติดตามโครงการมีอยู่แล้วบนฐานข้อมูลจริง)
- รันได้ขณะที่มีคนใช้แอป แต่ **แนะนำให้รันช่วงที่มีคนใช้น้อย** (เช่น เย็นหรือเช้าตรู่) เพราะต้องล็อกตาราง `projects`
  และ view ชั่วครู่ งานทั้งหมดอยู่ในบล็อก DO เดียว (คำสั่งเดียว แม้ SQL Editor จะ commit คั่นระหว่างคำสั่ง):
  - ขึ้น `canceling statement due to lock timeout` = มีคิวรีค้างอยู่ — ไม่มีอะไรเปลี่ยน รอ 1–2 นาทีแล้วรันใหม่
  - ขึ้น `deadlock detected` = ชนกับการใช้งานพอดี — ไม่มีอะไรเปลี่ยน รันใหม่ได้ทันที
- ใน Messages จะเห็น NOTICE `previous definition of public....` = นิยาม view เดิมก่อนถูกแทนที่ (เก็บไว้เป็นหลักฐาน)
  และ `view definitions: ...=original (replaced)` (รันครั้งแรก) หรือ `already current` (รันซ้ำ)
- รันซ้ำได้ปลอดภัย ถ้าขึ้น `has an unexpected column list - nothing was changed` หรือ
  `has an unexpected DEFINITION` แปลว่า view บนฐานข้อมูลจริงถูกแก้ไขไปจากสคริปต์ใน repo — ไม่มีอะไรเปลี่ยน ให้ส่งข้อความ error ให้ผู้พัฒนาดู
- **รัน SQL นี้ก่อน deploy หน้าเว็บรุ่นที่มีสวิตช์**

## ตรวจสอบหลังรัน (อ่านอย่างเดียว)

```sql
-- 1) คอลัมน์ใหม่: ต้องได้ boolean | NO | true
select data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'projects' and column_name = 'has_installments';

-- 2) view ยังเป็น security_invoker=on
select relname, reloptions from pg_class
where oid in ('public.project_tracking_overview'::regclass,
              'public.installment_summary'::regclass,
              'public.project_progress_latest'::regclass);

-- 3) ภาพรวมต่อโครงการ
select project_code, has_installments, installments_total, installments_overdue, next_installment_no
from public.project_tracking_overview order by project_code;

-- 4) หลังจากมีคนเปลี่ยนสวิตช์ในแอป: บันทึกการเปลี่ยน
select at, user_email, row_id, details
from public.audit_log
where table_name = 'projects' and details ? 'has_installments'
order by at desc limit 10;
```

ปิดสวิตช์ด้วย SQL (แทนการกดในแอป) ได้ เช่น
`update public.projects set has_installments = false where code = 'รหัสโครงการ';`

## ย้อนกลับ (Rollback)

- **แบบแนะนำ (ไม่มี DDL, ทันที)**: `update public.projects set has_installments = true;`
  ทุกโครงการกลับไปทำงานเหมือนก่อนรันสคริปต์ คอลัมน์ที่เหลืออยู่ไม่มีผลอะไร
- **แบบเอาคอลัมน์ออกจริง**: รัน `scripts/project-billing-flag-rollback.sql`
  (ลบ trigger กันสิทธิ์, สร้าง view ทั้งสามกลับเป็นรูปเดิมพร้อมสิทธิ์เดิม แล้วลบคอลัมน์; ค่าสวิตช์ของทุกโครงการหายไป,
  แถวงวดงานไม่ถูกแตะ) ต้อง deploy หน้าเว็บรุ่นที่ไม่ใช้ `has_installments` ก่อนหรือพร้อมกัน
  และหลังจากนั้นห้ามรัน `scripts/project-tracking.sql` ฉบับปัจจุบันซ้ำ (มันจะเพิ่มคอลัมน์กลับ)

## การรันสคริปต์ระบบติดตามโครงการซ้ำ

- `scripts/project-tracking.sql` ฉบับปัจจุบันมีคอลัมน์และ view แบบใหม่นี้อยู่แล้ว รันซ้ำแล้วสวิตช์ไม่หาย
- ถ้ารัน `project-tracking.sql` ซ้ำ ให้รัน `project-tracking-fix-1.sql`, `-fix-2.sql`, `-fix-3.sql`
  ต่อท้ายตามลำดับเสมอ (ไฟล์หลักสร้าง trigger รุ่นแรกกลับมา ซึ่ง fix-1/fix-2 แก้ไว้)
- ตั้งแต่ฉบับนี้ `project-tracking.sql` และ `project-tracking-fix-2.sql` **ไม่สร้าง policy แบบเปิดกว้าง
  (`using (true)`) ซ้ำ** เมื่อระบบล็อกอินรายบุคคล (auth-01/02) ติดตั้งแล้ว — ฉบับก่อนหน้านี้ถ้ารันซ้ำหลัง
  auth-02 จะทำให้ทุกบัญชีที่ล็อกอินอ่าน/แก้งวดงานและ % ความคืบหน้าของทุกโครงการได้
  **ห้ามรันไฟล์ฉบับเก่าจากประวัติ git บนฐานข้อมูลจริง**
- ตรวจว่าเคยเกิดปัญหานี้หรือไม่ (ต้องได้ 0 แถว; ถ้ามีแถว ให้รัน `scripts/auth-02-enforce-rls.sql` ซ้ำ
  ซึ่งจะลบ policy ทั้งหมดของตารางเหล่านี้แล้วสร้างแบบถูกต้องใหม่) — `project-billing-flag.sql` ก็เตือน
  เป็น WARNING ให้อัตโนมัติถ้าพบ:

```sql
select tablename, policyname from pg_policies
where schemaname = 'public' and (qual = 'true' or with_check = 'true')
  and tablename in ('projects','files','activity','progress_updates','project_installments',
                    'installment_events','installment_documents','project_checklist_templates');
```
