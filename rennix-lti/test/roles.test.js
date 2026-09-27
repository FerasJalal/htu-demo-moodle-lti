const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapLtiRolesToInternalRole } = require('../src/lti/roles');

test('membership#Instructor maps to course_supervisor', () => {
  const role = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';
  assert.equal(mapLtiRolesToInternalRole([role]), 'course_supervisor');
});

test('system/person#Administrator maps to course_supervisor', () => {
  const role = 'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator';
  assert.equal(mapLtiRolesToInternalRole([role]), 'course_supervisor');
});

test('membership#TeachingAssistant maps to section_instructor (regression: used to silently fall through to student)', () => {
  const role = 'http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant';
  assert.equal(mapLtiRolesToInternalRole([role]), 'section_instructor');
});

test('membership#ContentDeveloper maps to section_instructor', () => {
  const role = 'http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper';
  assert.equal(mapLtiRolesToInternalRole([role]), 'section_instructor');
});

test('membership#Learner maps to student', () => {
  const role = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
  assert.equal(mapLtiRolesToInternalRole([role]), 'student');
});

test('unknown role falls back to student', () => {
  assert.equal(mapLtiRolesToInternalRole(['http://example.com/some/other#Role']), 'student');
});

test('missing/empty roles falls back to student', () => {
  assert.equal(mapLtiRolesToInternalRole(undefined), 'student');
  assert.equal(mapLtiRolesToInternalRole([]), 'student');
});

test('supervisor role wins when multiple roles present', () => {
  const roles = [
    'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
    'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  ];
  assert.equal(mapLtiRolesToInternalRole(roles), 'course_supervisor');
});
