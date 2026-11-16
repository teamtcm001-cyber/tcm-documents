// Labels for the access model (mirrors scripts/auth-01-foundation.sql):
//   profiles.role         admin | exec | user
//   project_members.role  manager | editor | viewer     (only meaningful for role = 'user')
//     manager = edits like an editor AND adds / removes / re-roles the people of THAT project (scripts/auth-04-project-managers.sql)
export const ROLES = ['admin', 'exec', 'user']

export const ROLE_LABEL = {
  admin: 'แอดมิน',
  exec: 'ผู้บริหาร',
  user: 'สมาชิก',
}

export const ROLE_DESC = {
  admin: 'จัดการผู้ใช้และสิทธิ์ สร้าง/ลบโครงการ เห็นและแก้ไขได้ทุกโครงการ',
  exec: 'ผู้บริหาร (PD/MD) เห็นทุกโครงการ อ่านอย่างเดียว',
  user: 'สมาชิกโครงการ เห็นเฉพาะโครงการที่ได้รับสิทธิ์ (ผู้ดูแลโครงการ / แก้ไขได้ / ดูอย่างเดียวรายโครงการ)',
}

// tone for ToneBadge
export const ROLE_TONE = { admin: 'bad', exec: 'info', user: 'mute' }

export const MEMBERSHIP_LABEL = {
  none: 'ไม่มีสิทธิ์',
  viewer: 'ดูอย่างเดียว',
  editor: 'แก้ไขได้',
  manager: 'ผู้ดูแลโครงการ',
}

// per-project roles, most powerful first (sort order of the members panel)
export const MEMBER_ROLES = ['manager', 'editor', 'viewer']
export const MEMBER_ROLE_RANK = { manager: 0, editor: 1, viewer: 2 }
export const MEMBER_ROLE_TONE = { manager: 'info', editor: 'ok', viewer: 'mute' }
export const MEMBER_ROLE_DESC = {
  manager: 'แก้ไขโครงการได้ และเพิ่ม/ลบ/เปลี่ยนสิทธิ์คนในโครงการนี้ได้',
  editor: 'อัปโหลด แก้ไข และลบเอกสารของโครงการได้',
  viewer: 'ดูเอกสารและข้อมูลของโครงการได้อย่างเดียว',
}
// project_members.role values that may edit a project (mirror of can_edit_project())
export const EDIT_MEMBER_ROLES = ['editor', 'manager']

export const READ_ONLY_LABEL = 'อ่านอย่างเดียว'
export const NO_PROJECT_ACCESS_MESSAGE = 'ยังไม่ได้รับสิทธิ์เข้าถึงโปรเจกต์ใดๆ — ติดต่อผู้ดูแลระบบ'
