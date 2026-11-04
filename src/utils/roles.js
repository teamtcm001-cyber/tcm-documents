// Labels for the access model (mirrors scripts/auth-01-foundation.sql):
//   profiles.role         admin | exec | user
//   project_members.role  editor | viewer     (only meaningful for role = 'user')
export const ROLES = ['admin', 'exec', 'user']

export const ROLE_LABEL = {
  admin: 'แอดมิน',
  exec: 'ผู้บริหาร',
  user: 'สมาชิก',
}

export const ROLE_DESC = {
  admin: 'จัดการผู้ใช้และสิทธิ์ สร้าง/ลบโครงการ เห็นและแก้ไขได้ทุกโครงการ',
  exec: 'ผู้บริหาร (PD/MD) เห็นทุกโครงการ อ่านอย่างเดียว',
  user: 'สมาชิกโครงการ เห็นเฉพาะโครงการที่ได้รับสิทธิ์ (แก้ไขได้ หรือดูอย่างเดียวรายโครงการ)',
}

// tone for ToneBadge
export const ROLE_TONE = { admin: 'bad', exec: 'info', user: 'mute' }

export const MEMBERSHIP_LABEL = {
  none: 'ไม่มีสิทธิ์',
  viewer: 'ดูอย่างเดียว',
  editor: 'แก้ไขได้',
}

export const READ_ONLY_LABEL = 'อ่านอย่างเดียว'
export const NO_PROJECT_ACCESS_MESSAGE = 'ยังไม่ได้รับสิทธิ์เข้าถึงโปรเจกต์ใดๆ — ติดต่อผู้ดูแลระบบ'
