// No login means Supabase's `user` is the same shared account for everyone,
// so it can't identify who's actually using the app. This stores a
// self-reported name/employee code per browser instead, used purely for
// display/attribution (uploader name, activity log) — not authentication.
const KEY = 'tcm_local_display_name'

export function getLocalName() {
  return localStorage.getItem(KEY) || ''
}

export function setLocalName(name) {
  localStorage.setItem(KEY, name.trim())
}
