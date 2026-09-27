<?php
require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/classes/helper.php');

header('Content-Type: application/json');

try {
    $message = required_param('message', PARAM_TEXT);
    $historyraw = optional_param('history', '[]', PARAM_RAW);
    $cmid = optional_param('cmid', 0, PARAM_INT);
    $courseid = optional_param('courseid', 0, PARAM_INT);
    $position = optional_param('position', '', PARAM_RAW);
    $position = ($position === '' || !is_numeric($position)) ? null : (float) $position;

    if ($cmid) {
        $cm = get_coursemodule_from_id('', $cmid, 0, false, MUST_EXIST);
        $course = get_course($cm->course);
        require_login($course, false, $cm);
        $context = context_course::instance($cm->course);
    } else if ($courseid) {
        $course = get_course($courseid);
        require_login($course);
        $context = context_course::instance($courseid);
    } else {
        throw new moodle_exception('Either cmid or courseid is required.');
    }
    require_capability('local/rennixtutor:use', $context);
    require_sesskey();

    global $USER;
    if (!local_rennixtutorbot_helper::check_rate_limit($USER->id)) {
        echo json_encode(['error' => 'Too many messages -- please wait a moment before asking again.']);
        exit;
    }

    $language = local_rennixtutorbot_helper::detect_language($message);
    $languagename = $language === 'ar' ? 'Arabic' : 'English';

    if ($cmid) {
        $transcript = local_rennixtutorbot_helper::get_transcript($cmid);
        if (!$transcript) {
            echo json_encode(['error' => 'No transcript is available for this lecture yet.']);
            exit;
        }
        $systemprompt = local_rennixtutorbot_helper::build_lecture_prompt(
            $transcript['title'], $transcript['excerpts'], $languagename, $position
        );
    } else {
        $systemprompt = local_rennixtutorbot_helper::build_course_prompt($courseid, $languagename);
    }

    $messages = [['role' => 'system', 'content' => $systemprompt]];
    $history = json_decode($historyraw, true);
    if (is_array($history)) {
        foreach (array_slice($history, -6) as $turn) {
            $role = $turn['role'] ?? '';
            if (in_array($role, ['user', 'assistant'], true)) {
                $messages[] = ['role' => $role, 'content' => mb_substr((string) $turn['content'], 0, 2000)];
            }
        }
    }
    $messages[] = ['role' => 'user', 'content' => $message];

    $raw = local_rennixtutorbot_helper::call_openai($messages);
    [$clean, $citestart, $citeend] = local_rennixtutorbot_helper::extract_citation($raw);

    echo json_encode(['reply' => $clean, 'citeStart' => $citestart, 'citeEnd' => $citeend]);
} catch (\Throwable $e) {
    echo json_encode(['error' => $e->getMessage()]);
}
