<?php
defined('MOODLE_INTERNAL') || die();

function local_rennixtutorbot_extend_navigation_course($navigation, $course, $context) {
    // Superseded by the LTI "Rennix Tutor Bot" External Tool activity -- nav link
    // disabled so the course doesn't show both entry points side by side.
    return;

    if (!has_capability('local/rennixtutor:use', $context)) {
        return;
    }
    $url = new moodle_url('/local/rennixtutor/coursechat.php', ['id' => $course->id]);
    $navigation->add(
        get_string('coursetutorlink', 'local_rennixtutorbot'),
        $url,
        navigation_node::TYPE_SETTING,
        null,
        'rennixtutor',
        new pix_icon('i/messagecontentaudio', '')
    );
}
