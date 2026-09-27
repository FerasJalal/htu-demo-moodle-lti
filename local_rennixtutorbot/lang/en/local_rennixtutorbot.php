<?php
defined('MOODLE_INTERNAL') || die();

$string['pluginname'] = 'Rennix Tutor';
$string['rennixtutor:use'] = 'Chat with the AI tutor';
$string['coursetutorlink'] = 'Ask the Course Tutor';
$string['settings_apikey'] = 'OpenAI API key';
$string['settings_apikey_desc'] = 'Used to call OpenAI directly from Moodle -- no external server involved.';
$string['settings_model'] = 'Model';
$string['settings_model_desc'] = 'OpenAI chat model to use, e.g. gpt-4o-mini.';
$string['settings_videotracking'] = 'Vimeo video position for the Tutor Bot';
$string['settings_videotracking_desc'] = 'Lets the Rennix Tutor Bot (LTI) know which second of which Vimeo lecture video a student is at, so questions asked while watching are answered from that moment. On course pages, enrolled users\' Vimeo players report play/pause/seek positions to Rennix. Reports are signed with this site\'s LTI key and only take effect for students who have opened the Rennix Tutor Bot at least once.';
$string['settings_enablevideotracking'] = 'Share Vimeo video position with Rennix';
$string['settings_enablevideotracking_desc'] = 'Turn off to stop sending video positions entirely.';
$string['settings_rennixltiurl'] = 'Rennix LTI URL';
$string['settings_rennixltiurl_desc'] = 'Base URL of the Rennix LTI service, as used in the Rennix Tutor Bot External Tool (e.g. https://lti.rennix.ai). Must match the tool\'s host so the right External Tool (and client ID) is used.';
$string['privacy:metadata:rennix'] = 'Video positions (Vimeo video id, seconds, play/pause state) of enrolled users are sent to the Rennix LTI service to ground the Tutor Bot\'s answers.';
$string['privacy:metadata:rennix:userid'] = 'The Moodle user id (as the LTI subject), used to match the student\'s Rennix account.';
$string['privacy:metadata:rennix:position'] = 'The video and the second the student is at.';
