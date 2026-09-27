// ---- LTI role -> internal role mapping ----
// LTI 1.3 roles are full IMS vocabulary URNs (context roles such as
// .../membership#Instructor, or system roles such as .../system/person#Administrator),
// not free text. Matching them precisely -- instead of a blanket
// /Instructor|ContentDeveloper|Administrator/i regex, which would collapse every one of
// those into a single "instructor" bucket with identical rights -- is what lets
// different LTI roles carry different actual permissions. Two instructor-tier
// roles exist on tutor-service's side: 'course_supervisor' (full rights,
// including the Verification queue) and 'section_instructor' (content/analytics
// access, no verification authority). This is where that split gets decided, not
// left implicit at each call site.
const LTI_ROLE_SUPERVISOR_SUFFIXES = ['membership#Instructor', 'system/person#Administrator', 'institution/person#Administrator'];
const LTI_ROLE_SECTION_INSTRUCTOR_SUFFIXES = ['membership#ContentDeveloper', 'membership#TeachingAssistant'];

function mapLtiRolesToInternalRole(ltiRoles) {
  const roles = ltiRoles || [];
  if (roles.some((r) => LTI_ROLE_SUPERVISOR_SUFFIXES.some((suffix) => r.endsWith(suffix)))) return 'course_supervisor';
  if (roles.some((r) => LTI_ROLE_SECTION_INSTRUCTOR_SUFFIXES.some((suffix) => r.endsWith(suffix)))) return 'section_instructor';
  return 'student';
}

module.exports = { mapLtiRolesToInternalRole };
