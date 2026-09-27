<?php
defined('MOODLE_INTERNAL') || die();

$callbacks = [
    [
        'hook' => \core\hook\output\before_footer_html_generation::class,
        'callback' => [\local_rennixtutorbot\hook_callbacks::class, 'before_footer'],
    ],
];
